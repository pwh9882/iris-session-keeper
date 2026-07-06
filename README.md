# IRIS Session Keeper

[IRIS](https://www.iris.go.kr/resources/nui/index.do) 세션이 만료되지 않도록 5~10분 사이 랜덤 간격으로 세션 연장 버튼을 자동 클릭하는 브라우저 확장프로그램. **Chrome과 Firefox를 하나의 코드로 지원**합니다.

## 동작 방식

- 백그라운드에서 `alarms` API로 5~10분 사이 랜덤 딜레이의 알람을 등록합니다. (백그라운드 탭의 타이머 스로틀링에 영향받지 않음)
- 알람이 울리면 열려 있는 모든 `*.iris.go.kr` 탭의 **MAIN 월드**에 스크립트를 주입해 아래 코드를 실행합니다:

  ```js
  var f = nexacro.getApplication().mainframe.baseFrame.form.divTop.form;
  f.divTopComp_divTopSet_btn01_onclick.call(f, null, null);
  ```

- 클릭 2초 후 `f.sessionStartTime`이 현재 시각 근처로 리셋됐는지 읽어서 **갱신이 실제로 성공했는지 검증**합니다. 실패하면 툴바 배지가 `ERR`(빨강)로 바뀝니다.
- `f.sessionDuration`/`f.sessionStartTime`으로 계산한 남은 세션 시간이 다음 랜덤 간격보다 짧으면, 만료 2분 전에는 갱신되도록 알람을 앞당깁니다. (값이 ms 기준 5분~24시간 범위를 벗어나면 신뢰하지 않고 랜덤 간격만 사용)
- 팝업에서 남은 세션 시간을 실시간 카운트다운으로 확인할 수 있습니다.

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

- 설치하면 바로 동작합니다 (툴바 아이콘에 `ON` 배지 표시, 갱신 실패 시 `ERR`).
- 툴바 아이콘 클릭 → 팝업에서 켜기/끄기, 남은 세션 시간, 마지막·다음 갱신 시각 확인, 즉시 갱신 가능.
- IRIS 탭이 열려 있어야 갱신됩니다. 탭이 없으면 해당 회차는 건너뛰고 다음 알람을 기다립니다.

## 주의

- Chrome **메모리 절약 모드**가 IRIS 탭을 절전(discard)시키면 페이지 자체가 내려가 세션 유지가 안 됩니다. `chrome://settings/performance`에서 `iris.go.kr`를 "항상 활성 상태로 유지할 사이트"에 추가해 두는 것을 권장합니다.
- IRIS 페이지 구조(`divTop` 버튼 경로)가 바뀌면 갱신이 실패합니다. 팝업의 "마지막 갱신"이 실패로 표시되면 경로를 확인하세요.
