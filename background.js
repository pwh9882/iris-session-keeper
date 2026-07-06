// Chrome은 chrome.*, Firefox는 browser.*(프로미스 지원)를 사용
const api = globalThis.browser ?? globalThis.chrome;

const ALARM_NAME = 'iris-refresh';
const IRIS_URL_PATTERN = 'https://*.iris.go.kr/*';
const MIN_MINUTES = 5;
const MAX_MINUTES = 10;
const SAFETY_MARGIN_MINUTES = 2; // 세션 만료 전 최소한 이만큼 남기고 갱신
const VERIFY_DELAY_MS = 2000; // 클릭 후 서버 응답으로 sessionStartTime이 리셋될 때까지 대기
const RESET_TOLERANCE_MS = 15_000; // startTime이 이 안쪽이면 방금 리셋된 것으로 판정

// --- 아래 두 함수는 페이지 MAIN 월드에서 실행됨 (nexacro는 페이지 전역 객체) ---
function pageClickRefresh() {
  try {
    var f = nexacro.getApplication().mainframe.baseFrame.form.divTop.form;
    f.divTopComp_divTopSet_btn01_onclick.call(f, null, null);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function pageReadSession() {
  try {
    var f = nexacro.getApplication().mainframe.baseFrame.form.divTop.form;
    return {
      ok: true,
      duration: f.sessionDuration,
      startTime: f.sessionStartTime,
      now: Date.now(),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
// --- 여기까지 MAIN 월드 함수 ---

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function execInTab(tabId, func) {
  const [injection] = await api.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func,
  });
  return injection?.result ?? { ok: false, error: '주입 결과 없음' };
}

// sessionDuration이 ms 단위로 말이 되는 범위(5분~24시간)일 때만 스케줄링에 신뢰
function isSaneSession(info) {
  return (
    info.ok &&
    Number.isFinite(info.duration) &&
    Number.isFinite(info.startTime) &&
    info.duration >= 5 * 60_000 &&
    info.duration <= 24 * 60 * 60_000
  );
}

async function isEnabled() {
  const { enabled = true } = await api.storage.local.get('enabled');
  return enabled;
}

async function updateBadge() {
  const { enabled = true, lastRun = null } = await api.storage.local.get(['enabled', 'lastRun']);
  if (!enabled) {
    await api.action.setBadgeText({ text: '' });
    return;
  }
  const failed = lastRun && !lastRun.ok;
  await api.action.setBadgeText({ text: failed ? 'ERR' : 'ON' });
  await api.action.setBadgeBackgroundColor({ color: failed ? '#c62828' : '#2e7d32' });
}

async function scheduleNext() {
  let delayInMinutes = MIN_MINUTES + Math.random() * (MAX_MINUTES - MIN_MINUTES);

  // 남은 세션 시간이 랜덤 간격보다 짧으면 만료 전에 갱신되도록 앞당김
  const { session = null } = await api.storage.local.get('session');
  if (session) {
    const remainingMs = session.duration - (Date.now() - session.startTime);
    if (remainingMs > 0) {
      const cap = remainingMs / 60_000 - SAFETY_MARGIN_MINUTES;
      if (cap < delayInMinutes) delayInMinutes = Math.max(0.5, cap);
    }
  }

  await api.alarms.create(ALARM_NAME, { delayInMinutes });
  await api.storage.local.set({ nextAt: Date.now() + delayInMinutes * 60_000 });
}

async function cancelSchedule() {
  await api.alarms.clear(ALARM_NAME);
  await api.storage.local.set({ nextAt: null });
}

// 열려 있는 IRIS 탭에서 세션 정보만 읽어옴 (팝업의 남은 시간 표시용)
async function readSession() {
  const tabs = await api.tabs.query({ url: IRIS_URL_PATTERN });
  if (tabs.length === 0) return { ok: false, error: 'IRIS 탭이 열려 있지 않음' };

  try {
    const info = await execInTab(tabs[0].id, pageReadSession);
    if (isSaneSession(info)) {
      await api.storage.local.set({
        session: { duration: info.duration, startTime: info.startTime },
      });
    }
    return info;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function runRefresh() {
  const tabs = await api.tabs.query({ url: IRIS_URL_PATTERN });
  if (tabs.length === 0) {
    const result = { ok: false, error: 'IRIS 탭이 열려 있지 않음' };
    await api.storage.local.set({ lastRun: { at: Date.now(), ...result } });
    await updateBadge();
    return result;
  }

  let verified = 0;
  let lastError = null;

  for (const tab of tabs) {
    try {
      const click = await execInTab(tab.id, pageClickRefresh);
      if (!click.ok) {
        lastError = click.error;
        continue;
      }

      // 클릭만으로 성공 판정하지 않고 sessionStartTime 리셋까지 확인
      await sleep(VERIFY_DELAY_MS);
      const info = await execInTab(tab.id, pageReadSession);
      if (isSaneSession(info)) {
        await api.storage.local.set({
          session: { duration: info.duration, startTime: info.startTime },
        });
      }
      if (info.ok && Number.isFinite(info.startTime) && info.now - info.startTime < RESET_TOLERANCE_MS) {
        verified++;
      } else {
        lastError = info.ok ? '클릭 후 세션 시작시각이 리셋되지 않음' : info.error;
      }
    } catch (e) {
      lastError = String(e);
    }
  }

  const result =
    verified > 0
      ? { ok: true, detail: `탭 ${tabs.length}개 중 ${verified}개 갱신 확인` }
      : { ok: false, error: lastError ?? '알 수 없는 오류' };

  await api.storage.local.set({ lastRun: { at: Date.now(), ...result } });
  await updateBadge();
  return result;
}

api.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  if (!(await isEnabled())) return;
  await runRefresh();
  await scheduleNext();
});

api.runtime.onInstalled.addListener(async () => {
  await updateBadge();
  if (await isEnabled()) await scheduleNext();
});

api.runtime.onStartup.addListener(async () => {
  await updateBadge();
  if (await isEnabled()) await scheduleNext();
});

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case 'toggle': {
        const enabled = !(await isEnabled());
        await api.storage.local.set({ enabled });
        if (enabled) {
          await scheduleNext();
        } else {
          await cancelSchedule();
        }
        await updateBadge();
        sendResponse({ enabled });
        break;
      }
      case 'refresh-now': {
        const result = await runRefresh();
        if (await isEnabled()) await scheduleNext();
        sendResponse(result);
        break;
      }
      case 'read-session': {
        sendResponse(await readSession());
        break;
      }
      default:
        sendResponse(null);
    }
  })();
  return true; // 비동기 sendResponse 유지
});
