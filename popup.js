const api = globalThis.browser ?? globalThis.chrome;

const IRIS_ORIGINS = ['https://*.iris.go.kr/*'];

const $status = document.getElementById('status');
const $remaining = document.getElementById('remaining');
const $lastRun = document.getElementById('last-run');
const $nextRun = document.getElementById('next-run');
const $refreshCount = document.getElementById('refresh-count');
const $toggle = document.getElementById('toggle');
const $refreshNow = document.getElementById('refresh-now');
const $permBox = document.getElementById('perm-box');
const $grant = document.getElementById('grant');

let session = null;
let nextAt = null; // 다음 자동갱신 시각 (비활성화 상태면 null)

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

// 초 단위 계산을 벽시계 초 경계에 맞춰서 두 카운트다운이 같은 순간에 줄어들게 함
function secondsUntil(deadline, now) {
  return Math.floor(deadline / 1000) - Math.floor(now / 1000);
}

function tickRemaining(now) {
  if (!session) {
    $remaining.textContent = '-';
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

function tick() {
  const now = Date.now();
  tickRemaining(now);
  tickNextRun(now);
}

async function render() {
  const stored = await api.storage.local.get(['enabled', 'nextAt', 'lastRun', 'session', 'refreshCount']);
  const { enabled = true, lastRun = null, refreshCount = 0 } = stored;
  session = stored.session ?? null;
  nextAt = enabled ? stored.nextAt ?? null : null;

  $status.textContent = enabled ? '동작 중' : '중지됨';
  $status.className = `value ${enabled ? 'ok' : 'err'}`;

  $toggle.textContent = enabled ? '끄기' : '켜기';
  $toggle.className = enabled ? 'on' : 'off';

  if (lastRun) {
    if (lastRun.ok) {
      $lastRun.textContent = formatTime(lastRun.at);
      $lastRun.className = 'value ok';
      $lastRun.title = lastRun.detail ?? '';
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
    await api.runtime.sendMessage({ type: 'read-session' });
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
