// Chrome은 chrome.*, Firefox는 browser.*(프로미스 지원)를 사용
const api = globalThis.browser ?? globalThis.chrome;

const ALARM_NAME = 'iris-refresh';
const IRIS_URL_PATTERN = 'https://*.iris.go.kr/*';
// 인증 상태 오라클 겸 서버 세션 keep-alive. CSRF 토큰 없이 동작하며
// 로그인 중이면 gdsSSOChk === 'Y', 아니면 'N'(로그아웃)이나 'NOT_TOKEN'(만료) 등
const SSO_CHECK_URL = 'https://www.iris.go.kr/lgin/lginadmn/ssoChk.do';
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
  // 홈페이지(index.do 등) 탭에는 nexacro가 없음 — 실패가 아니라 클릭 대상이 아닌 것
  if (typeof nexacro === 'undefined') {
    return { ok: false, na: true, error: 'nexacro 없음 (업무포털 탭 아님)' };
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
  let color = '#4C6FE8'; // 아이콘 배경(네이비) 위에서 잘 보이는 브랜드 블루
  if (lastRun && !lastRun.ok) {
    if (lastRun.expired) {
      text = 'EXP';
      color = '#EF4B81'; // 브랜드 핑크 — 주의(재로그인 필요)
    } else if (lastRun.offline) {
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

// 열려 있는 IRIS 탭에서 세션 정보만 읽어옴 (팝업의 남은 시간 표시용).
// 첫 탭이 홈페이지(nexacro 없음)일 수 있으므로 읽힐 때까지 전체 탭을 순회
async function readSession() {
  const tabs = await api.tabs.query({ url: IRIS_URL_PATTERN });

  let lastError = 'IRIS 탭이 열려 있지 않음';
  for (const tab of tabs) {
    try {
      const info = await execInTab(tab.id, pageReadSession);
      if (isSaneSession(info)) {
        await api.storage.local.set({
          session: { duration: info.duration, startTime: info.startTime },
        });
        return info;
      }
      if (!info.ok) lastError = info.error;
    } catch (e) {
      lastError = String(e);
    }
  }
  // 못 읽었으면 저장된 값도 비움 — 닫힌 탭의 옛 세션으로 카운트다운하는 것 방지
  await api.storage.local.set({ session: null });
  return { ok: false, error: lastError };
}

// 서버 세션 keep-alive 핑 겸 생사 확인. IRIS 탭이 없어도 host 권한만 있으면
// 쿠키가 실려 서버 idle timeout(2시간)이 리셋됨
async function pingServer() {
  try {
    const res = await fetch(SSO_CHECK_URL, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return { alive: null, error: `HTTP ${res.status}` };
    const data = await res.json().catch(() => null);
    if (!data || data.gdsSSOChk === undefined) return { alive: null, error: '응답 형식을 인식할 수 없음' };
    return { alive: data.gdsSSOChk === 'Y', code: data.gdsSSOChk };
  } catch (e) {
    return { alive: null, error: String(e) };
  }
}

async function notifyExpired() {
  try {
    await api.notifications?.create('iris-session-expired', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'IRIS 세션 만료',
      message: 'IRIS 서버 세션이 만료되었습니다. 다시 로그인해 주세요.',
    });
  } catch {
    // 알림이 불가능한 환경이면 배지(EXP)로만 표시
  }
}

// 서버 세션 상태를 저장하고, 살아있음→만료 전환 시에만 한 번 알림
async function markServerState(alive) {
  const { serverAlive = null } = await api.storage.local.get('serverAlive');
  await api.storage.local.set({ server: { alive, at: Date.now() }, serverAlive: alive });
  if (serverAlive === true && alive === false) await notifyExpired();
}

// "살린 시간" 카운터의 기준점. 세션이 살아있음을 처음 확인한 시점을 기록하고
// 팝업이 (지금 - 기준점)을 실시간 카운터로 표시. 세션이 만료되면 리셋되며,
// 확장을 끄거나 브라우저를 재시작할 때도 리셋됨
async function updateKeptAliveAnchor(alive) {
  const { keptAliveSince = null } = await api.storage.local.get('keptAliveSince');
  if (alive && keptAliveSince === null) {
    await api.storage.local.set({ keptAliveSince: Date.now() });
  } else if (!alive && keptAliveSince !== null) {
    await api.storage.local.set({ keptAliveSince: null });
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

  // 1) 서버 세션 핑: 탭 유무와 무관하게 idle timeout을 리셋하고 생사를 판정
  // (핑이 불확실(null)하면 카운터는 건드리지 않음 — 일시적 네트워크 오류로 리셋 방지)
  const ping = await pingServer();
  if (ping.alive !== null) {
    await markServerState(ping.alive);
    await updateKeptAliveAnchor(ping.alive);
  }

  if (ping.alive === false) {
    // 서버 세션이 죽었으면 클릭해봐야 소용없음 — 재로그인 전까지는 만료 상태로 보고
    // (알람은 계속 돌아서 재로그인하면 자동으로 정상 상태로 복귀)
    const result = { ok: false, expired: true, error: '서버 세션 만료 — 다시 로그인해 주세요' };
    await api.storage.local.set({ lastRun: { at: Date.now(), ...result }, session: null });
    await updateBadge();
    return result;
  }

  // 2) 업무포털 탭의 30분 클라이언트 타이머는 서버 핑으로 리셋되지 않으므로,
  //    열려 있는 탭에서는 여전히 연장 버튼을 클릭해야 함
  const tabs = await api.tabs.query({ url: IRIS_URL_PATTERN });

  let verified = 0;
  let applicable = 0; // nexacro가 있는(=클릭 대상인) 탭 수
  let lastError = null;
  let sawOffline = false;

  for (const tab of tabs) {
    try {
      const click = await execInTab(tab.id, pageClickRefresh);
      if (!click.ok) {
        if (click.na) continue; // 홈페이지 등 nexacro 없는 탭은 실패로 치지 않음
        applicable++;
        lastError = click.error;
        if (click.offline) sawOffline = true;
        continue;
      }
      applicable++;

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

  let result;
  if (verified > 0) {
    result = { ok: true, detail: `업무포털 탭 ${applicable}개 중 ${verified}개 갱신 확인` };
  } else if (applicable === 0) {
    // 클릭할 업무포털 탭이 없음 — 서버 핑이 성공했으면 세션은 유지되고 있는 것
    result =
      ping.alive === true
        ? { ok: true, pingOnly: true, detail: '업무포털 탭 없음 — 서버 핑으로 세션 유지' }
        : { ok: false, error: ping.error ?? 'IRIS 탭이 없고 서버 핑도 실패' };
  } else {
    result = { ok: false, error: lastError ?? '알 수 없는 오류', ...(sawOffline && { offline: true }) };
  }

  if (result.ok && !result.pingOnly) {
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

// 설치/시작/켜기 직후 알람을 기다리지 않고 즉시 1회 실행해
// 팝업 상태(서버 세션 등)가 바로 채워지고 살린 시간 카운터도 바로 시작되게 함
async function startFresh() {
  await api.storage.local.set({ keptAliveSince: null });
  await updateBadge();
  if (await isEnabled()) {
    await runRefresh();
    await scheduleNext();
  }
}

api.runtime.onInstalled.addListener(async () => {
  await api.storage.local.remove(['keptAliveMs', 'lastAliveAt']); // 구버전 누적 통계 키 정리
  await startFresh();
});

api.runtime.onStartup.addListener(startFresh);

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case 'toggle': {
        const enabled = !(await isEnabled());
        await api.storage.local.set({ enabled });
        if (enabled) {
          await runRefresh(); // 켜자마자 즉시 확인 — 살린 시간 카운터도 여기서 시작
          await scheduleNext();
        } else {
          await cancelSchedule();
          await api.storage.local.set({ keptAliveSince: null }); // 끄면 카운터 리셋
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
