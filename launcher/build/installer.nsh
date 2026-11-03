; 통합 클라우드 설치 파일에 더하는 NSIS 스크립트 (package.json build.nsis.include)

; 제거 프로그램의 구성 요소 화면에 보이는 이름 (기본은 영어 'Uninstall')
!define UNINSTALL_SECTION_NAME "마고에듀 통합 클라우드와 설치한 프로그램"

; 지울 때: 통합 클라우드로 켠 프로그램(타종·오답노트 …)을 끄고, 설치한 프로그램·통합 클라우드가 만든 프로그램 바로 가기·
; magoedu:// 주소·자동 실행 등록을 지운다 (src/main/uninstall.js). 통합 클라우드 파일을 지우기 전에 한다.
; 새 버전으로 업데이트하거나 다시 설치할 때도 예전 버전의 제거 프로그램이 돌기 때문에, 그때는 아무것도 하지 않는다.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-cleanup'
  ${endIf}
!macroend

; '데이터도 지우기'(처음엔 꺼져 있음): 로그인 정보와 계정별 프로그램 데이터(%APPDATA%\MagoEduCloud).
; 위의 정리가 끝나 통합 클라우드가 이 폴더를 쓰지 않을 때 지운다. 조용히 도는 업데이트 때는 고르지 않으므로 지우지 않음
!macro customUnInstallSection
  Section /o "un.데이터도 지우기 (로그인 정보, 동기화한 데이터)" unDeleteData
    ${ifNot} ${isUpdated}
      RMDir /r "$APPDATA\MagoEduCloud"
    ${endIf}
  SectionEnd
!macroend
