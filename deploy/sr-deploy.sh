#!/usr/bin/env bash
# VM 수집기(worker) 배포 스크립트.
#
# CI 의 deploy_worker 잡이 sudo 로 부른다. 보안상 이 파일은 레포 밖 고정 위치
# (/usr/local/bin/sr-deploy.sh, root 소유)에 복사해 두고 sudoers 로 그 경로만 허용한다.
# 레포 안 스크립트를 직접 sudo 로 물리면 누군가 push 로 내용을 바꿔 root 를 탈취할 수 있다.
#
# 설치(최초 1회, VM 에서 root):
#   sudo cp deploy/sr-deploy.sh /usr/local/bin/sr-deploy.sh
#   sudo chown root:root /usr/local/bin/sr-deploy.sh
#   sudo chmod 755 /usr/local/bin/sr-deploy.sh
#   echo 'gitlab-runner ALL=(root) NOPASSWD: /usr/local/bin/sr-deploy.sh' | sudo tee /etc/sudoers.d/gitlab-runner-deploy
set -euo pipefail

APP_DIR=/home/collector/workspace/paas-automation
BRANCH=main

cd "$APP_DIR"
git fetch origin
git checkout "$BRANCH"
# origin/main 에 정확히 맞춘다. 추적 파일만 되돌리며 .env·data/ 등 미추적 파일은 건드리지 않는다.
git reset --hard "origin/$BRANCH"
npm ci
# 상시 서비스 재시작(collector/worker.ts). systemd 유닛명은 broadcom-sr.
systemctl restart broadcom-sr
echo "배포 완료: $(git rev-parse --short HEAD) → broadcom-sr 재시작"
