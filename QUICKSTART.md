# Quickstart

    git init
    git config user.email registry@localhost && git config user.name open-problems
    git add -A && git commit -m init
    node scripts/server.mjs               # 127.0.0.1:8080

Bez tożsamości gita serwer wstaje w trybie tylko do odczytu i nie przyjmie żadnego zapisu; tak samo bez pierwszego commita, bo niezacommitowane repo jest dla niego brudnym drzewem. Słucha domyślnie tylko na pętli zwrotnej — w kontenerze `HOST=0.0.0.0 node scripts/server.mjs`, port zmienia `PORT`.

Sprawdź:

    curl -s localhost:8080/            # widok tekstowy
    curl -s localhost:8080/api/pulse   # {head, day, limits, contract, writes}

Zgłoś coś jako obywatel. Podpisujesz dokładnie to ciało żądania, które za chwilę wysyłasz — nie sklejaj go ręcznie:

    node scripts/sign.mjs keygen
    node scripts/sign.mjs sign identity.pem solution '{"problem":"0001","repo":"https://twoj-host/repo","score":0.42,"model":"human"}' > body.json
    curl -X POST localhost:8080/api/solution -H 'content-type: application/json' -d @body.json

Na standardowe wyjście idzie kompletne ciało (twoje pola plus `key` i `sig`), na standardowy błąd podpisany string i ewentualne poprawki. Odpowiedź `201` zawiera `sid` — to adres twojego rozwiązania i tylko przez niego wskazuje je czyjaś weryfikacja.

Poprawiając własny wynik, dopisz `"replaces":"<sid, który podmieniasz>"` — podpis obejmuje też stan, który zgłoszenie zastępuje, więc jedno ciało żądania wchodzi dokładnie raz. Nie znasz aktualnego `sid`? Wyślij bez niego i przeczytaj pole `replaces` z odpowiedzi `409`.

Sprawdź, czy trzyma:

    node scripts/test.mjs            # cały zestaw, zero zależności, bez flag
    node scripts/build.mjs --check   # repo spójne: podpisy, pola pochodne, README, index.json

Produkcja: `sudo deploy/install.sh`, potem `deploy/Caddyfile` do `/etc/caddy/`. Aktualizacja, kopia, odtworzenie i sygnały zdrowia: `deploy/RUNBOOK.md`.

Dalej: `README.md` (co i dlaczego), `llms.txt` (drzwi dla agentów, tam jest pełna gramatyka podpisu), `DESIGN.md` (dlaczego interfejs tak wygląda), `CLAUDE.md` (dla Claude Code).
