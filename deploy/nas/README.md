# deploy/nas — Synology(Container Manager) + Nginx Proxy Manager 배포 레시피

단일 컨테이너(node:24-alpine) 허브 배포. 폴더 구조:

```
<프로젝트 폴더>/            # 예: /volume1/docker_store/LTNC
├── docker-compose.yaml    # 이 폴더의 것 사용 (Container Manager 프로젝트로 로드)
├── .env                   # .env.example 복사 — LTNC_PORT, TZ
├── app/                   # repo 의 package.json·package-lock.json·packages/·node_modules/·docs/ 복사
│                          #   (deps 가 순수 JS(ws·yaml)라 빌드 없이 폴더 복사로 끝)
├── config/config.yaml     # config.example.yaml 기반 — bind: 0.0.0.0(컨테이너 내부), dataDir: /data,
│                          #   agents[] 토큰 = `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
└── data/                  # 비워두면 hub 가 SQLite 생성 — 백업 대상
```

리버스 프록시(NPM): 도메인 → `http://<NAS_IP>:8420`, **Websockets Support ON**(필수), SSL 발급+강제.
검증: `https://<도메인>/api/health`. 업데이트: app/ 교체 후 컨테이너 재시작(data/ 불변).

> node:24-alpine = `node:sqlite` 무플래그. Node 22 베이스를 쓰려면 command 에 `--experimental-sqlite` 추가.
