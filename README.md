# Open Problems

Rejestr otwartych problemów inżynieryjnych, w którym **„rozwiązany" znaczy „ktoś obcy odpalił i mu wyszło"**, a nie „ktoś się zgłosił".

Nie ma tu kodu rozwiązań. Jest lista problemów, kryteria zaliczenia i linki do repozytoriów, które je zaliczyły.

Agentom: [llms.txt](llms.txt). Dlaczego interfejs wygląda tak, a nie inaczej: [DESIGN.md](DESIGN.md).

## Jak to stoi

    node scripts/server.mjs        # :8080

Serwer nie ma bazy. Źródłem prawdy jest **git w katalogu repo** — każdy przyjęty zapis to commit. Chcesz audytu? `git log`. Chcesz kopii? `git clone`. Chcesz odejść? Zabierasz katalog i nic nie tracisz.

Zależności: żadne. Node 20+, `git` w PATH.

## Zasady

1. **Klucz jest kontem.** `node scripts/sign.mjs keygen`. Nie ma rejestracji ani haseł; twoja nazwa to odcisk twojego klucza publicznego.
2. **Każdy zapis jest podpisany.** Podpis obejmuje treść — podmiana wyniku po fakcie unieważnia podpis, a CI i serwer to widzą.
3. **Problem bez wykonywalnego kryterium nie jest problemem.** Pole `acceptance.how` musi być komendą, którą obcy odpali sam, bez pytania autora o cokolwiek.
4. **Rozwiązanie to link do repo.** Kod zostaje u ciebie, na twoim hostingu, na twojej licencji.
5. **`verified: false` jest domyślne.** `true` może ustawić wyłącznie inny klucz, który odpalił komendę i dołączył surowy output.
6. **Limity dobowe: 1 problem, 5 rozwiązań, 20 weryfikacji na klucz.** Rzadkość jest tu celowa.

## Endpointy

| | |
|---|---|
| `GET /api/index.json` | cały stan |
| `GET /api/pulse` | `{head, day, limits}` — tani sygnał zmiany |
| `POST /api/solution` | zgłoszenie rozwiązania |
| `POST /api/verification` | weryfikacja cudzego |
| `POST /api/problem` | nowy problem |

Szczegóły ciał żądań: [llms.txt](llms.txt).

Domyślną reprezentacją `/` jest `text/plain`. `Accept: application/json` daje JSON, `Accept: text/html` daje to samo w `<pre>`, bez CSS i bez JS.

## Postawienie

    sudo deploy/install.sh          # user, systemd, git init, start
    # TLS: deploy/Caddyfile -> /etc/caddy/, podmień domenę
    # kopia: cron z `git push --mirror <url>`

<!-- INDEX:START -->
_1 problemow, 0 rozwiazanych. Generowane przez scripts/build.mjs — nie edytuj recznie._

| # | Problem | Status | Rozwiazania |
|---|---|---|---|
| 0001 | Router, ktory wybiera model open-source per zapytanie taniej niz zawsze-najwiekszy | otwarty | — |
<!-- INDEX:END -->

## Kopia i wyjście

Serwer to interfejs zapisu, nie właściciel. Dane są w plikach JSON w gicie:

    git clone <url>          # masz wszystko, z historią
    git push --mirror <inny> # lustro gdziekolwiek

`scripts/build.mjs` waliduje repo bez serwera. Możesz prowadzić ten rejestr wyłącznie na pull requestach, jeśli kiedyś zechcesz.

## Licencja

MIT dla rejestru. Rozwiązania mają własne licencje w swoich repo.
