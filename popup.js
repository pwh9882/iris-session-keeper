const api = globalThis.browser ?? globalThis.chrome;

const IRIS_ORIGINS = ['https://*.iris.go.kr/*'];

const $status = document.getElementById('status');
const $server = document.getElementById('server');
const $remaining = document.getElementById('remaining');
const $lastRun = document.getElementById('last-run');
const $nextRun = document.getElementById('next-run');
const $refreshCount = document.getElementById('refresh-count');
const $keptAlive = document.getElementById('kept-alive');
const $toggle = document.getElementById('toggle');
const $refreshNow = document.getElementById('refresh-now');
const $permBox = document.getElementById('perm-box');
const $grant = document.getElementById('grant');

let session = null;
let nextAt = null; // 다음 자동갱신 시각 (비활성화 상태면 null)
let keptAliveSince = null; // 살린 시간 카운터 기준점 (세션 유지 확인 시작 시각)
let sessionNote = null; // 남은 세션을 읽지 못한 이유 (업무포털 탭 없음 등)

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatSeconds(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = String(totalSec % 60).padStart(2, '0');
  return `${m}분 ${s}초`;
}

// 유지 시간(ms)을 실시간 카운터용으로 포맷 — 1시간 미만은 초 단위로 움직임
function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 3600) return formatSeconds(totalSec);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (d > 0) return `${d}일 ${h}시간`;
  return `${h}시간 ${m}분`;
}

// 초 단위 계산을 벽시계 초 경계에 맞춰서 두 카운트다운이 같은 순간에 줄어들게 함
function secondsUntil(deadline, now) {
  return Math.floor(deadline / 1000) - Math.floor(now / 1000);
}

function tickRemaining(now) {
  if (!session) {
    $remaining.textContent = sessionNote ?? '-';
    $remaining.className = 'value';
    return;
  }
  const sec = secondsUntil(session.startTime + session.duration, now);
  if (sec <= 0) {
    $remaining.textContent = '만료됨';
    $remaining.className = 'value err';
    return;
  }
  $remaining.textContent = formatSeconds(sec);
  $remaining.className = `value ${sec < 5 * 60 ? 'warn' : 'ok'}`;
}

function tickNextRun(now) {
  if (!nextAt) {
    $nextRun.textContent = '-';
    $nextRun.title = '';
    return;
  }
  const sec = secondsUntil(nextAt, now);
  $nextRun.textContent = sec <= 0 ? '곧 실행' : `${formatSeconds(sec)} 후`;
  $nextRun.title = formatTime(nextAt);
}

function tickKeptAlive(now) {
  if (!keptAliveSince) {
    $keptAlive.textContent = '-';
    $keptAlive.title = '';
    return;
  }
  $keptAlive.textContent = formatDuration(now - keptAliveSince);
  $keptAlive.title = `${formatTime(keptAliveSince)}부터 유지 중`;
}

function tick() {
  const now = Date.now();
  tickRemaining(now);
  tickNextRun(now);
  tickKeptAlive(now);
}

async function render() {
  const stored = await api.storage.local.get(['enabled', 'nextAt', 'lastRun', 'session', 'refreshCount', 'server', 'keptAliveSince']);
  const { enabled = true, lastRun = null, refreshCount = 0, server = null } = stored;
  session = stored.session ?? null;
  nextAt = enabled ? stored.nextAt ?? null : null;
  keptAliveSince = stored.keptAliveSince ?? null;

  $status.textContent = enabled ? '동작 중' : '중지됨';
  $status.className = `value ${enabled ? 'ok' : 'err'}`;

  if (server) {
    $server.textContent = server.alive ? '정상' : '만료 — 재로그인 필요';
    $server.className = `value ${server.alive ? 'ok' : 'err'}`;
    $server.title = `마지막 확인 ${formatTime(server.at)}`;
  } else {
    $server.textContent = '-';
    $server.className = 'value';
    $server.title = '';
  }

  $toggle.textContent = enabled ? '끄기' : '켜기';
  $toggle.className = enabled ? 'on' : 'off';

  if (lastRun) {
    if (lastRun.ok) {
      $lastRun.textContent = formatTime(lastRun.at);
      $lastRun.className = 'value ok';
      $lastRun.title = lastRun.detail ?? '';
    } else if (lastRun.expired) {
      $lastRun.textContent = `세션 만료 (${formatTime(lastRun.at)})`;
      $lastRun.className = 'value err';
      $lastRun.title = 'IRIS에 다시 로그인하면 자동으로 유지가 재개됩니다';
    } else if (lastRun.offline) {
      $lastRun.textContent = `오프라인 (${formatTime(lastRun.at)})`;
      $lastRun.className = 'value warn';
      $lastRun.title = '네트워크 연결이 복구되면 자동으로 다시 시도합니다';
    } else {
      $lastRun.textContent = `실패 (${formatTime(lastRun.at)})`;
      $lastRun.className = 'value err';
      $lastRun.title = lastRun.error ?? '';
    }
  } else {
    $lastRun.textContent = '-';
    $lastRun.className = 'value';
    $lastRun.title = '';
  }

  $refreshCount.textContent = `${refreshCount.toLocaleString('ko-KR')}회`;
  tick();
}

async function checkPermission() {
  // Firefox MV3는 호스트 권한을 설치 시 자동으로 주지 않으므로 여기서 확인/요청
  const granted = await api.permissions.contains({ origins: IRIS_ORIGINS });
  $permBox.classList.toggle('visible', !granted);
  return granted;
}

async function requestFreshSession() {
  try {
    const res = await api.runtime.sendMessage({ type: 'read-session' });
    // 타이머를 못 읽었으면 그 이유를 포털 타이머 자리에 표시.
    // 참고: 로그아웃 상태에서는 포털 주소를 열어도 홈페이지로 리다이렉트되므로 탭 없음이 맞음
    sessionNote = res && !res.ok ? '포털 탭 없음' : null;
    if (res && !res.ok) $remaining.title = res.error ?? '';
    await render();
  } catch {
    // 백그라운드가 응답하지 않아도 저장된 값으로 표시
  }
}

$grant.addEventListener('click', async () => {
  const granted = await api.permissions.request({ origins: IRIS_ORIGINS });
  if (granted) {
    $permBox.classList.remove('visible');
    await requestFreshSession();
  }
});

$toggle.addEventListener('click', async () => {
  await api.runtime.sendMessage({ type: 'toggle' });
  await render();
});

$refreshNow.addEventListener('click', async () => {
  $refreshNow.disabled = true;
  await api.runtime.sendMessage({ type: 'refresh-now' });
  $refreshNow.disabled = false;
  await render();
});

api.storage.onChanged.addListener(render);

// 벽시계 초가 바뀌는 순간에 맞춰 갱신 (약간의 여유를 둬서 경계 직후에 실행)
(function scheduleTick() {
  setTimeout(() => {
    tick();
    scheduleTick();
  }, 1000 - (Date.now() % 1000) + 20);
})();

(async () => {
  await render();
  if (await checkPermission()) {
    await requestFreshSession();
  }
})();
