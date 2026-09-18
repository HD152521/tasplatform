#!/usr/bin/env bash
# VM 수집기(worker) 배포 스크립트.
#
# CI 의 deploy_worker 잡이 sudo 로 부른다:  sudo /usr/local/bin/sr-deploy.sh "$CI_PROJECT_DIR"
# 러너가 이미 체크아웃한 소스($1)를 앱 디렉터리로 동기화하고 재시작한다.
# git fetch 를 하지 않으므로 HTTP 리모트 자격증명이 필요 없다(러너가 CI 토큰으로 이미 받음).
#
# 보안: 이 파일은 레포 밖 고정 위치(/usr/local/bin/sr-deploy.sh, root 소유)에 두고
#       sudoers 로 그 경로만 허용한다. 레포 안 스크립트를 직접 sudo 로 물리면 push 로 탈취 가능.
#
# 설치(코드 갱신 때마다 1회 복사):
#   sudo cp deploy/sr-deploy.sh /usr/local/bin/sr-deploy.sh
#   sudo chown root:root /usr/local/bin/sr-deploy.sh && sudo chmod 755 /usr/local/bin/sr-deploy.sh
set -euo pipefail

SRC="${1:?source dir required (CI_PROJECT_DIR)}"   # 러너 체크아웃 경로
APP_DIR=/home/collector/workspace/paas-automation

# 소스 → 앱 디렉터리 동기화.
#   보존: .env(시크릿), data/(세션·로컬 파일)
#   제외: node_modules(target 에서 npm ci 로 재생성), .git(불필요)
rsync -a --delete \
  --exclude='.env' --exclude='data/' --exclude='node_modules/' --exclude='.git/' \
  "$SRC"/ "$APP_DIR"/

cd "$APP_DIR"
npm ci
systemctl restart broadcom-sr
echo "배포 완료 → broadcom-sr 재시작"
