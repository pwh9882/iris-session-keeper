# IRIS Session Keeper

[IRIS](https://www.iris.go.kr/resources/nui/index.do) 세션이 만료되지 않도록 5~10분 사이 랜덤 간격으로 세션 연장 버튼을 자동 클릭하는 브라우저 확장프로그램. **Chrome과 Firefox를 하나의 코드로 지원**합니다.

## 동작 방식

IRIS에는 두 개의 타임아웃이 있고, 확장은 두 계층을 모두 다룹니다 (2026-07-06 라이브 실측 기준):

| 계층 | 길이 | 리셋 방법 |
|---|---|---|
| 서버 세션 (idle timeout) | 2시간 | 인증 상태로 서버에 닿는 아무 요청 |
| 업무포털 클라이언트 타이머 (nexacro) | 30분 | "시간 연장" 버튼 클릭 |

- 백그라운드에서 `alarms` API로 5~10분 사이 랜덤 딜레이의 알람을 등록합니다. (백그라운드 탭의 타이머 스로틀링에 영향받지 않음)
- **1단계 — 서버 세션 keep-alive**: service worker가 직접 `POST /lgin/lginadmn/ssoChk.do`를 호출합니다. CSRF 토큰 없이 동작하고 host 권한으로 세션 쿠키가 실리므로, **IRIS 탭이 하나도 없어도** 서버의 2시간 idle timeout이 리셋됩니다. 응답의 `gdsSSOChk`가 세션 생사 판정도 겸합니다 — `Y`면 정상, `NOT_TOKEN`이면 세션이 죽은 것이므로 배지를 `EXP`(보라)로 바꾸고 데스크톱 알림을 한 번 띄웁니다. (재로그인하면 자동으로 정상 상태로 복귀)
- **2단계 — 업무포털 30분 타이머**: 열려 있는 업무포털 탭의 **MAIN 월드**에 스크립트를 주입해 연장 버튼을 클릭합니다 (홈페이지처럼 nexacro가 없는 탭은 건너뜀):

  ```js
  var f = nexacro.getApplication().mainframe.baseFrame.form.divTop.form;
  f.divTopComp_divTopSet_btn01_onclick.call(f, null, null);
  ```

- 클릭 2초 후 `f.sessionStartTime`이 현재 시각 근처로 리셋됐는지 읽어서 **갱신이 실제로 성공했는지 검증**합니다. 실패하면 툴바 배지가 `ERR`(빨강)로 바뀝니다.
- `f.sessionDuration`/`f.sessionStartTime`으로 계산한 남은 세션 시간이 다음 랜덤 간격보다 짧으면, 만료 2분 전에는 갱신되도록 알람을 앞당깁니다. (값이 ms 기준 5분~24시간 범위를 벗어나면 신뢰하지 않고 랜덤 간격만 사용)
- 팝업에서 서버 세션 상태와 남은 세션 시간(실시간 카운트다운)을 확인할 수 있습니다.

## 설치

### Chrome

1. `chrome://extensions` 접속
2. 우측 상단 **개발자 모드** 켜기
3. **압축해제된 확장 프로그램을 로드합니다** 클릭 → 이 폴더 선택
4. manifest의 Firefox 전용 키(`browser_specific_settings`, `background.scripts`)에 대한 경고가 떠도 무시하면 됩니다.

### Firefox (128 이상)

1. `about:debugging#/runtime/this-firefox` 접속
2. **임시 부가 기능 로드…** 클릭 → 이 폴더의 `manifest.json` 선택
3. **권한 허용**: Firefox MV3는 호스트 권한을 자동으로 주지 않습니다. 툴바 아이콘 클릭 → 팝업 상단의 **권한 허용** 버튼을 눌러 `iris.go.kr` 접근을 허용하세요.

> 임시 부가 기능은 Firefox를 재시작하면 사라집니다. 영구 설치하려면 [AMO에 자체 배포용으로 서명](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)을 받거나, Firefox Developer Edition에서 `about:config` → `xpinstall.signatures.required = false` 설정 후 zip(xpi)으로 설치하면 됩니다.

## 사용법

- 설치하면 바로 동작합니다. 툴바 배지: `ON`(정상) / `NET`(오프라인, 복구 시 자동 재시도) / `ERR`(연장 버튼 클릭 실패) / `EXP`(서버 세션 만료 — 재로그인 필요).
- 툴바 아이콘 클릭 → 팝업에서 켜기/끄기, 서버 세션 상태, 남은 세션 시간, 마지막·다음 갱신 시각 확인, 즉시 갱신 가능.
- **IRIS 탭이 없어도 서버 세션은 유지됩니다** (로그인 상태 기준). 업무포털 탭의 30분 타이머 연장은 해당 탭이 열려 있을 때만 수행됩니다.

## 주의

- 노트북이 **2시간 이상 잠자기**에 들어가면 그동안 아무 요청도 못 보내므로 서버 세션이 만료됩니다. 이 경우는 어떤 keep-alive로도 막을 수 없고, 깨어난 뒤 첫 확인에서 `EXP` 배지와 알림으로 재로그인이 필요함을 알려줍니다.
- 직접 로그아웃한 직후에도 "세션 만료" 알림이 한 번 뜰 수 있습니다 (살아있음→만료 전환 감지 방식이라서).
- Chrome **메모리 절약 모드**가 IRIS 탭을 절전(discard)시켜도 서버 세션은 service worker 핑으로 유지되지만, 그 탭의 30분 클라이언트 타이머는 연장할 수 없습니다. 업무포털에서 작성 중인 내용이 있다면 `chrome://settings/performance`에서 `iris.go.kr`를 "항상 활성 상태로 유지할 사이트"에 추가해 두는 것을 권장합니다.
- IRIS 페이지 구조(`divTop` 버튼 경로)나 세션 정책(2시간 idle, `ssoChk.do` 응답 형식)이 바뀌면 동작이 달라질 수 있습니다. 팝업의 "마지막 갱신"이 실패로 표시되면 확인하세요.
