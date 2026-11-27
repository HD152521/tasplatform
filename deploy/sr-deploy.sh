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
# systemd 유닛 broadcom-sr 이 돌리는 사용자. Playwright 브라우저 캐시가 이 사용자 홈에 있어야 한다.
RUN_USER=collector

# 소스 → 앱 디렉터리 동기화.
#   보존: .env(시크릿), data/(세션·로컬 파일)
#   제외: node_modules(target 에서 npm ci 로 재생성), .git(불필요)
rsync -a --delete \
  --exclude='.env' --exclude='data/' --exclude='node_modules/' --exclude='.git/' \
  "$SRC"/ "$APP_DIR"/

cd "$APP_DIR"

# 앱 디렉터리를 서비스 사용자 소유로 돌려놓는다.
#
# 이 스크립트는 sudo(root)로 돌고 rsync -a 도 root 로 쓰므로, 놔두면 앱 디렉터리가
# 통째로 root 소유가 된다. 그러면 collector 로 도는 수집기가 세션을 못 쓴다:
#   EACCES: permission denied, open '.../data/session.json'
# data/ 는 rsync 에서 제외라 동기화가 건드리지 않지만, 한 번 root 소유가 되면
# 그대로 남는다. 매 배포마다 맞춰 둔다(이미 맞으면 하는 일이 없다).
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR"

# npm ci 도 서비스 사용자로 돈다 — root 로 돌리면 node_modules 가 다시 root 소유가 된다.
sudo -u "$RUN_USER" npm ci

# Playwright 브라우저는 **서비스를 돌리는 사용자의 캐시**에 있어야 한다.
#
# 이 스크립트는 sudo(root)로 돈다. 그래서 npm ci 의 postinstall 이 브라우저를 받아도
# /root/.cache/ms-playwright 에 들어간다. 정작 서비스는 collector 로 돌며
# /home/collector/.cache/ms-playwright 를 보므로,
#   browserType.launch: Executable doesn't exist at
#   /home/collector/.cache/ms-playwright/chromium_headless_shell-XXXX/...
# 로 로그인이 통째로 막힌다. playwright 를 올릴 때마다 빌드 번호가 바뀌므로
# 한 번 받아 두는 것으로 끝나지 않는다 — 배포마다 맞춘다.
#
# 이미 있으면 금방 끝난다(내려받지 않는다). 시스템 라이브러리(--with-deps)는 root 가
# 필요해 여기서 하지 않는다. 처음 한 번만 아래를 직접 실행한다:
#   sudo npx playwright install-deps chromium
if ! sudo -u "$RUN_USER" npx playwright install chromium; then
  echo "경고: Playwright 브라우저 설치 실패 — 로그인이 안 될 수 있습니다" >&2
fi

# 옛 브라우저 버전은 지운다 — 안 지우면 무한히 쌓인다.
#
# 바로 위 install 은 빌드 번호가 바뀌면 **새 폴더를 만들고 옛 폴더는 두고 간다.**
# chromium 한 벌이 460MB, headless shell 까지 560MB다. 그게 쌓여 VM 루트(19G)가 100%
# 가 되었고, CI 가 소스를 받는 단계에서 죽어 배포가 멈췄다. 로그에 남은 것은
# `printf: write error: No space left on device` 한 줄이라 원인이 보이지도 않았다.
#
# 지울 목록을 버전 번호로 적어 두면 다음 업그레이드에 또 어긋난다. 그래서 playwright
# 에게 **지금 어느 자리를 쓰는지 직접 묻고**(--dry-run 이 Install location 을 찍는다)
# 그 자리만 남긴다.
#
# 확인에 실패하면 **아무것도 지우지 않는다.** 지우는 쪽으로 틀리면
#   browserType.launch: Executable doesn't exist at .../chromium_headless_shell-XXXX
# 로 로그인이 통째로 막힌다. 자리를 아끼려다 수집기를 세우는 것은 남는 장사가 아니다.
prune_old_browsers() {
  local root keep name size
  root=$(sudo -u "$RUN_USER" sh -c 'echo "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"')
  [ -d "$root" ] || return 0

  keep=$(sudo -u "$RUN_USER" npx playwright install --dry-run chromium 2>/dev/null | sed -n 's/^[[:space:]]*Install location:[[:space:]]*//p' | sed 's#.*/##' | sort -u)
  if [ -z "$keep" ]; then
    echo "경고: 쓰는 브라우저를 확인하지 못해 정리를 건너뜁니다" >&2
    return 0
  fi

  # chromium 계열만 건드린다. firefox·webkit 은 우리가 깐 것이 아니다.
  for dir in "$root"/chromium*; do
    [ -d "$dir" ] || continue
    name=$(basename "$dir")
    if printf '%s
' "$keep" | grep -qxF "$name"; then
      continue
    fi
    size=$(du -sh "$dir" 2>/dev/null | cut -f1)
    echo "옛 브라우저 정리: $name ($size)"
    rm -rf "$dir"
  done
}
prune_old_browsers

systemctl restart broadcom-sr
echo "배포 완료 → broadcom-sr 재시작"
