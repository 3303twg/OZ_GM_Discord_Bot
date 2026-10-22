# 서버 세팅

명령은 그 디스코드 서버 안에서, 채널 관리 권한이 있는 계정으로 실행합니다. 새 서버는 설정이 비어 있고, 서버 ID는 봇이 알아서 잡습니다.

## 1. 시트 공유

맥에서 서비스 계정 메일을 확인합니다.

```bash
cd ~/discord-report-bot && node -e "console.log(JSON.parse(require('fs').readFileSync('secrets/service-account.json','utf8')).client_email)"
```

대시보드, 보고로그, 업무불참은 편집자로 공유합니다. 명단과 리뷰어 작업은 뷰어로 충분합니다.

## 2. 시트 주소

탭이 열린 주소 그대로 넣습니다. 주소에 `gid=`가 있어야 합니다.

```
/setsheet type:대시보드 link:탭주소
/setsheet type:보고로그 link:탭주소
/setsheet type:업무불참 link:탭주소
/setsheet type:명단 link:탭주소
/setsheet type:리뷰어작업 link:탭주소
```

리뷰어 작업을 비우면 리뷰어 마감 확인은 하지 않습니다. 업무불참을 비우면 불참 보고만 막힙니다.

## 3. 명단 열

A열은 1입니다. `header`를 비우면 10행, `active`를 비우면 `근무중`입니다.

```
/setroster name:이름열 job:직무열 status:근무상태열 header:헤더행 active:넣을값
```

지정한 헤더 행 다음부터 읽습니다. 헤더 글자는 보지 않습니다. 근무상태 칸이 `active` 값과 같은 사람만 대시보드에 넣습니다.

지금 OZ 명단은 아래와 같습니다.

```
/setroster name:2 job:4 status:8 header:10 active:근무중
```

## 4. 결과 채널

명령을 그 채널 안에서 실행합니다.

```
/setchannel type:Daily
/setchannel type:Close
/setchannel type:Absent
```

## 5. 확인

```
/settings
/reload
/pannel
```

`/settings`에 대시보드, 보고로그, 명단, 명단 열, 채널 세 개가 있어야 보고가 됩니다. `/reload`는 명단을 대시보드에 다시 씁니다. `/pannel`은 현재 채널에 버튼을 올립니다. 다시 실행하면 버튼 메시지가 하나 더 생깁니다.

보고는 최대 1분 뒤에 시트에 기록됩니다. 바로 쓰려면 `/flush`를 실행합니다.

닉네임은 서버 닉네임의 첫 `_` 앞부분과 명단 이름이 같아야 합니다. 직무는 명단 값을 그대로 쓰고, `리뷰어`만 마감 때 작업 시트를 확인합니다.
