# 업무 보고 봇

`#보고` 채널의 버튼 세 개로 양식을 열고, 전송하면 해당 보고 채널에 메시지를 올린 뒤 구글 시트 `보고로그` 탭에 한 줄을 추가합니다.

| 버튼 | 결과가 올라가는 채널 |
| --- | --- |
| 일일 업무 보고 | `CHANNEL_DAILY_ID` |
| 일일 마감 보고 | `CHANNEL_CLOSE_ID` |
| 업무 불참 보고 | `CHANNEL_ABSENT_ID` |

양식 항목은 보고 일자, 역할, 내용입니다. 역할 목록은 `config/roles.json`에서 바꿉니다. 바꾼 뒤에는 봇을 재시작합니다.

시트에 이미 훈련생 명단이 있으므로 봇은 그 시트를 수정하지 않습니다. `보고로그` 탭이 없으면 만들어 헤더를 넣고, 그 아래에만 추가합니다.

## 1. 디스코드 봇

1. https://discord.com/developers/applications 에서 New Application. 이름은 메시지에 그대로 보이므로 `업무 보고 Bot`처럼 정합니다.
2. Bot 메뉴에서 Reset Token으로 토큰을 만들고 `.env`의 `DISCORD_TOKEN`에 넣습니다. 토큰은 채팅에 붙이지 않습니다.
3. 같은 Bot 메뉴에서 Public Bot은 꺼도 됩니다. Privileged Gateway Intents는 전부 끕니다. 이 봇은 메시지 내용을 읽지 않습니다.
4. OAuth2 → General에서 Application ID를 복사해 `DISCORD_CLIENT_ID`에 넣습니다.
5. OAuth2 → URL Generator에서 scope는 `bot`, 권한은 View Channels, Send Messages, Embed Links, Read Message History를 고릅니다.
6. 나온 주소로 서버에 초대합니다. 봇이 버튼 채널과 보고 결과 채널 네 곳을 볼 수 있어야 합니다.

## 2. 채널 ID

디스코드 설정 → 고급 → 개발자 모드를 켭니다. 채널 우클릭 → ID 복사를 `.env`에 넣습니다.

- `GUILD_ID`: 서버 이름 우클릭
- `PANEL_CHANNEL_ID`: `#보고`
- `CHANNEL_DAILY_ID`: 일일 업무 보고가 올라갈 채널
- `CHANNEL_CLOSE_ID`: 일일 마감 보고가 올라갈 채널
- `CHANNEL_ABSENT_ID`: 업무 불참 보고가 올라갈 채널

## 3. 구글 시트

1. 봇을 올릴 GCP 프로젝트, 또는 시트용으로 만든 프로젝트에서 Google Sheets API를 사용 설정합니다.
2. IAM → 서비스 계정 → 계정 생성. 역할은 비워 둡니다. 키 탭에서 JSON 키를 받아 `secrets/service-account.json`으로 저장합니다.
3. 시트에서 공유를 누르고, 서비스 계정 이메일(`...@...iam.gserviceaccount.com`)에 편집자 권한을 줍니다.
4. `.env`의 `SPREADSHEET_ID`는 시트 주소의 `/d/`와 `/edit` 사이 값입니다. 예시에 대상 시트 ID가 들어 있습니다.
5. `SHEET_TAB=보고로그`는 그대로 둡니다.

서비스 계정은 공유된 시트 전체를 읽을 수 있습니다. 명단에 개인정보가 있으므로 키 파일은 이 서버에만 두고, git이나 채팅에 올리지 않습니다.

## 4. PC에서 설정 확인

```powershell
cd C:\Users\3303t\Projects\discord-report-bot
copy .env.example .env
```

`.env`를 채운 뒤 키 파일을 `secrets\service-account.json`에 둡니다.

```powershell
npm install
npm run check
npm start
```

로그인 로그가 보이고 `#보고`에 버튼이 생기면 됩니다. 버튼은 재시작해도 같은 메시지를 수정하므로 중복으로 쌓이지 않습니다. 메시지가 지워졌으면 채널 관리 권한이 있는 계정으로 `/panel`을 실행합니다.

## 5. GCP 무료 VM

결제 계정은 연결해야 하지만, 아래를 지키면 e2-micro 1대는 상시 무료입니다. 예산을 1달러로 만들어 두면 조건이 어긋났을 때 바로 알 수 있습니다.

Compute Engine → VM 인스턴스 만들기:

| 항목 | 값 |
| --- | --- |
| 리전 | `us-west1` (또는 `us-central1`, `us-east1`) |
| 머신 | `e2-micro` |
| 부팅 디스크 | Ubuntu 24.04 LTS, **표준 영구 디스크**, 30GB |
| 방화벽 | HTTP/HTTPS 체크 해제. 봇은 밖으로 접속만 합니다 |
| 네트워크 서비스 등급 | 표준 |

끄거나 빼 둘 것: Ops Agent, 스냅샷, GPU, 고정 외부 IP. 외부 IP는 임시(ephemeral)로 둡니다. 봇은 들어오는 주소가 필요 없습니다.

## 6. 서버에 올리기

PC에서 압축합니다. `node_modules`와 비밀 파일은 빼야 합니다.

```powershell
cd C:\Users\3303t\Projects
tar --exclude=discord-report-bot/node_modules --exclude=discord-report-bot/.git --exclude=discord-report-bot/secrets --exclude=discord-report-bot/data --exclude=discord-report-bot/.env -a -c -f discord-report-bot.zip discord-report-bot
scp discord-report-bot.zip 사용자이름@VM외부IP:~
scp C:\Users\3303t\Projects\discord-report-bot\.env 사용자이름@VM외부IP:~
scp C:\Users\3303t\Projects\discord-report-bot\secrets\service-account.json 사용자이름@VM외부IP:~
```

VM에 SSH로 들어간 뒤:

```bash
sudo apt update
sudo apt install -y curl ca-certificates unzip
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

sudo useradd --system --create-home --shell /usr/sbin/nologin bot || true
sudo unzip -o ~/discord-report-bot.zip -d /opt
sudo mkdir -p /opt/discord-report-bot/secrets
sudo mv ~/.env /opt/discord-report-bot/.env
sudo mv ~/service-account.json /opt/discord-report-bot/secrets/service-account.json
sudo chown -R bot:bot /opt/discord-report-bot
sudo chmod 600 /opt/discord-report-bot/.env /opt/discord-report-bot/secrets/service-account.json

sudo -u bot npm ci --omit=dev --prefix /opt/discord-report-bot
sudo cp /opt/discord-report-bot/deploy/discord-report-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now discord-report-bot
sudo systemctl status discord-report-bot
```

로그는 `journalctl -u discord-report-bot -f` 입니다.

코드를 다시 올릴 때는 zip을 같은 방식으로 풀고 `sudo systemctl restart discord-report-bot` 하면 됩니다. `.env`와 `secrets`는 덮어쓰지 않아도 됩니다.

## 동작

1. `#보고`의 버튼을 누릅니다.
2. 모달에서 보고 일자, 역할, 내용을 입력하고 전송합니다. 보고 일자는 한국 시간으로 채워져 있고, 고칠 수 있습니다.
3. 종류에 맞는 채널에 작성자 멘션과 함께 보고가 올라갑니다. 여러 줄은 글머리표로 바뀝니다.
4. 시트 `보고로그`에 작성시각, 보고유형, 작성자, 사용자ID, 보고일자, 역할, 내용, 메시지링크가 한 줄 추가됩니다.
5. 누른 사람에게만 "전송했습니다"가 보입니다. 시트 기록만 실패하면 채널 링크와 함께 실패했다고 알려 줍니다.
