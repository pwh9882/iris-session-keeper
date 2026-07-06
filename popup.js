const api = globalThis.browser ?? globalThis.chrome;

const IRIS_ORIGINS = ['https://*.iris.go.kr/*'];

const $status = document.getElementById('status');
const $remaining = document.getElementById('remaining');
const $lastRun = document.getElementById('last-run');
const $nextRun = document.getElementById('next-run');
const $toggle = document.getElementById('toggle');
const $refreshNow = document.getElementById('refresh-now');
const $permBox = document.getElementById('perm-box');
const $grant = document.getElementById('grant');

let session = null;

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function tickRemaining() {
  if (!session) {
    $remaining.textContent = '-';
    $remaining.className = 'value';
    return;
  }
  const ms = session.duration - (Date.now() - session.startTime);
  if (ms <= 0) {
    $remaining.textContent = '만료됨';
    $remaining.className = 'value err';
    return;
  }
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = String(totalSec % 60).padStart(2, '0');
  $remaining.textContent = `${m}분 ${s}초`;
  $remaining.className = `value ${ms < 5 * 60_000 ? 'warn' : 'ok'}`;
}

async function render() {
  const stored = await api.storage.local.get(['enabled', 'nextAt', 'lastRun', 'session']);
  const { enabled = true, nextAt = null, lastRun = null } = stored;
  session = stored.session ?? null;

  $status.textContent = enabled ? '동작 중' : '중지됨';
  $status.className = `value ${enabled ? 'ok' : 'err'}`;

  $toggle.textContent = enabled ? '끄기' : '켜기';
  $toggle.className = enabled ? 'on' : 'off';

  if (lastRun) {
    $lastRun.textContent = lastRun.ok
      ? formatTime(lastRun.at)
      : `실패 (${formatTime(lastRun.at)})`;
    $lastRun.className = `value ${lastRun.ok ? 'ok' : 'err'}`;
    $lastRun.title = lastRun.detail ?? lastRun.error ?? '';
  } else {
    $lastRun.textContent = '-';
    $lastRun.className = 'value';
    $lastRun.title = '';
  }

  $nextRun.textContent = enabled && nextAt ? formatTime(nextAt) : '-';
  tickRemaining();
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
setInterval(tickRemaining, 500);

(async () => {
  await render();
  if (await checkPermission()) {
    await requestFreshSession();
  }
})();
