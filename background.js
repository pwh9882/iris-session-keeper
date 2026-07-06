// Chrome은 chrome.*, Firefox는 browser.*(프로미스 지원)를 사용
const api = globalThis.browser ?? globalThis.chrome;

const ALARM_NAME = 'iris-refresh';
const IRIS_URL_PATTERN = 'https://*.iris.go.kr/*';
const MIN_MINUTES = 5;
const MAX_MINUTES = 10;
const SAFETY_MARGIN_MINUTES = 2; // 세션 만료 전 최소한 이만큼 남기고 갱신
const OFFLINE_RETRY_MINUTES = 1; // 오프라인이면 짧게 재시도해 연결 복구 직후 갱신
const VERIFY_DELAY_MS = 2000; // 클릭 후 서버 응답으로 sessionStartTime이 리셋될 때까지 대기
const RESET_TOLERANCE_MS = 15_000; // startTime이 이 안쪽이면 방금 리셋된 것으로 판정

// --- 아래 두 함수는 페이지 MAIN 월드에서 실행됨 (nexacro는 페이지 전역 객체) ---
function pageClickRefresh() {
  // 오프라인 상태에서 클릭하면 넥사크로가 "invalid nexacro communication format"
  // 오류 팝업을 띄우므로, 클릭하지 않고 건너뜀
  if (!navigator.onLine) {
    return { ok: false, offline: true, error: '오프라인 상태' };
  }
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
  let text = 'ON';
  let color = '#2e7d32';
  if (lastRun && !lastRun.ok) {
    if (lastRun.offline) {
      text = 'NET';
      color = '#ef6c00';
    } else {
      text = 'ERR';
      color = '#c62828';
    }
  }
  await api.action.setBadgeText({ text });
  await api.action.setBadgeBackgroundColor({ color });
}

async function scheduleNext() {
  // 오프라인이면 클릭해봐야 실패하므로 짧은 간격으로만 재시도
  if (!navigator.onLine) {
    await api.alarms.create(ALARM_NAME, { delayInMinutes: OFFLINE_RETRY_MINUTES });
    await api.storage.local.set({ nextAt: Date.now() + OFFLINE_RETRY_MINUTES * 60_000 });
    return;
  }

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
  // 백그라운드에서 먼저 오프라인이면 페이지를 건드리지 않고 건너뜀
  if (!navigator.onLine) {
    const result = { ok: false, offline: true, error: '오프라인 상태 — 연결이 복구되면 자동으로 다시 시도' };
    await api.storage.local.set({ lastRun: { at: Date.now(), ...result } });
    await updateBadge();
    return result;
  }

  const tabs = await api.tabs.query({ url: IRIS_URL_PATTERN });
  if (tabs.length === 0) {
    const result = { ok: false, error: 'IRIS 탭이 열려 있지 않음' };
    await api.storage.local.set({ lastRun: { at: Date.now(), ...result } });
    await updateBadge();
    return result;
  }

  let verified = 0;
  let lastError = null;
  let sawOffline = false;

  for (const tab of tabs) {
    try {
      const click = await execInTab(tab.id, pageClickRefresh);
      if (!click.ok) {
        lastError = click.error;
        if (click.offline) sawOffline = true;
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
      } else if (!navigator.onLine) {
        // 클릭과 확인 사이에 네트워크가 끊긴 경우
        sawOffline = true;
        lastError = '갱신 중 네트워크가 끊김';
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
      : { ok: false, error: lastError ?? '알 수 없는 오류', ...(sawOffline && { offline: true }) };

  if (result.ok) {
    const { refreshCount = 0 } = await api.storage.local.get('refreshCount');
    await api.storage.local.set({ refreshCount: refreshCount + 1 });
  }
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

// 연결이 복구되면 알람을 기다리지 않고 즉시 갱신
// (백그라운드가 깨어 있을 때만 동작하는 보조 장치 — 잠들어 있으면 1분 재시도 알람이 처리)
globalThis.addEventListener?.('online', async () => {
  if (!(await isEnabled())) return;
  const { lastRun = null } = await api.storage.local.get('lastRun');
  if (!lastRun?.offline) return;
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
