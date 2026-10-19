# 바이브 코딩 입문 클래스

Claude Code로 배우는 바이브 코딩 입문 오프라인 클래스(2시간) 홍보 페이지와 수강 신청 서버입니다.

- 일정별 남은 자리 표시, 회차당 최대 6명
- 신청 시 휴대폰 문자 인증 (솔라피), 신청 완료 문자에 수강 안내 링크(`/info`) 발송
- `/admin.html` 관리자 페이지: 방문 통계(방문자, 유입 경로), 강의 일정 추가·수정·숨김, 신청자 명단과 CSV 내려받기

## 채워 넣을 것
- `public/index.html` 에서 노란색으로 표시된 `[...]` 부분: 수강료, 장소, 강사 정보, 환불 규정, 문의처
- 강의 일정은 관리자 페이지에서 관리합니다. `schedule.json` 은 처음 배포할 때 한 번만 쓰이는 초기값이에요.

## 환경 변수 (Railway → Variables)
| 이름 | 설명 |
| --- | --- |
| `SOLAPI_API_KEY` | 솔라피 API 키 |
| `SOLAPI_API_SECRET` | 솔라피 API 시크릿 |
| `SOLAPI_SENDER` | 솔라피에 등록된 발신번호 |
| `ADMIN_PHONE` | 새 신청 알림 문자를 받을 번호 (여러 개면 쉼표로 구분) |
| `INFO_URL` | (선택) 신청 완료 문자에 넣는 안내 페이지 주소. 기본값 `aieo.kr/info` |
| `SITE_URL` | (선택) 대표 주소. 기본값 `https://aieo.kr`. Railway 기본 주소로 들어오면 이 주소로 넘겨요 |
| `GOOGLE_SITE_VERIFICATION` | (선택) 구글 서치 콘솔 HTML 태그의 content 값 |
| `NAVER_SITE_VERIFICATION` | (선택) 네이버 서치어드바이저 HTML 태그의 content 값 |
| `ADMIN_KEY` | 관리자 페이지 비밀번호 (저장소에는 넣지 마세요) |
| `DATA_DIR` | (선택) 데이터 저장 경로. Railway에 볼륨을 붙이면 자동으로 그 경로를 써서 비워 둬도 돼요 |

**Railway 서비스에 볼륨(서비스 카드 우클릭 → Attach Volume, 마운트 경로 `/data`)을 꼭 붙이세요.** 볼륨이 없으면 재배포할 때마다 일정·신청자·방문 통계가 사라지고, 관리자 화면 위에 경고가 뜹니다.

## 로컬 실행
```
npm install
npm start
```
솔라피 키 없이 실행하면 문자 대신 화면과 콘솔에 인증번호가 표시되는 개발 모드로 동작합니다.

## 검색 최적화
- `/robots.txt`, `/sitemap.xml` 은 서버가 자동으로 만들어요. 관리자·안내 페이지와 API는 검색에서 빠져요.
- 첫 화면에 일정 목록과 강의 정보(Course), 자주 묻는 질문(FAQPage) 구조화 데이터를 서버에서 넣어 줘요.
- 구글 서치 콘솔과 네이버 서치어드바이저에 `https://aieo.kr` 을 등록하고, 받은 확인 값을 위 환경 변수에 넣은 뒤 `https://aieo.kr/sitemap.xml` 을 제출하세요.
