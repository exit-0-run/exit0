# RUNBOOK

Operacyjna instrukcja dla `/srv/exit0`. Instalator: `deploy/install.sh`.
Reguła nadrzędna: **źródłem prawdy jest git w katalogu usługi**, a nie proces. Jeśli
masz kopię tego katalogu, masz cały rejestr.

## Instalacja

    git clone <repo> /opt/exit0-src
    cd /opt/exit0-src
    sudo deploy/install.sh

Skrypt: sprawdza node 20+, zakłada użytkownika `exit0`, kopiuje kod do
`/srv/exit0`, zasiewa `problems/` i `README.md` (tylko gdy ich tam nie ma),
buduje, commituje, renderuje unit pod wykrytą ścieżkę node, startuje usługę i czeka na
`/api/pulse`. Kończy się niezerowo, jeśli serwer nie odpowie — „gotowe” znaczy
„odpowiada”.

TLS:

    cp /srv/exit0/deploy/Caddyfile /etc/caddy/Caddyfile
    # podmień `exit0.example` na swoją domenę
    systemctl reload caddy

Zmienne, które instalator honoruje: `DIR`, `UNIT_DIR`, `SVC_USER`, `SVC_GROUP`, `PORT`.
Zmiana portu to `sudo PORT=9090 deploy/install.sh` **plus** poprawiony `reverse_proxy`
w Caddyfile.

## Aktualizacja

    cd /opt/exit0-src
    git pull
    sudo deploy/install.sh

To jest cała procedura. Instalator sam zatrzymuje usługę, podmienia **wyłącznie kod**
(`scripts/`, `deploy/`, `llms.txt`, dokumenty, `problems/_schema.json`), przebudowuje,
commituje efekt i startuje z powrotem.

**Nigdy nie rób `git pull` w `/srv/exit0`.** Historia tego katalogu to historia
rejestru, a nie historia kodu — to dwa różne repozytoria, które nie mają wspólnego
przodka.

Instalator odmówi pracy, jeśli zastanie tam niezacommitowane zmiany. To celowe: takie
zmiany to albo ręczna edycja w toku, albo przerwany zapis. Rozwiąż je (`Awarie`) i
powtórz.

## Kopia zapasowa

Kopia to `git push --mirror`. Najpierw skonfiguruj zdalne repozytorium raz, ręcznie —
instalator tego nie zgaduje:

    # klucz wdrożeniowy roota musi mieć prawo zapisu do lustra
    git -C /srv/exit0 remote add mirror git@twoj-host:ty/exit0-backup.git
    git -C /srv/exit0 push --mirror mirror     # pierwszy raz ręcznie, żeby zobaczyć błąd

Potem cron:

    # /etc/cron.d/exit0-backup
    17 * * * * root git -C /srv/exit0 push --mirror mirror || logger -t exit0 "kopia zapasowa nie poszla"

Czego **nie** backupujemy: `.state/` (liczniki dobowe i lockfile — celowo ulotne,
skasowanie ich zeruje limity) oraz `identity.pem`, którego serwer w ogóle nie ma.

Nie trzymaj w `/srv/exit0` niczego swojego: zrzutu bazy, archiwum, kluczy SSH.
Katalog domowy użytkownika usługi wskazuje na to samo miejsce, więc `~/.ssh` też się tu
liczy. Każdy nieśledzony plik to dla serwera brudne drzewo, czyli **zatrzymane zapisy**
(`.gitignore` zwalnia z tego tylko `.state/`, `identity.pem` i `node_modules/`).

Katalog `problems/evidence/` rośnie z ruchem i jako jedyny nie da się odtworzyć z
niczego innego. Pilnuj rozmiaru: `du -sh /srv/exit0/problems/evidence`.

## Odtworzenie

    git clone <lustro> /srv/exit0
    cd /opt/exit0-src && sudo deploy/install.sh

Klon przynosi dane i historię; instalator dokłada kod, tożsamość gita, unit i start.
Ponieważ świeży klon jest czysty, kontrola „niezacommitowane zmiany” przechodzi.

Sanity check po odtworzeniu — **z katalogu rejestru**, nie ze źródeł:

    (cd /srv/exit0 && node scripts/build.mjs --check)
    curl -s localhost:8080/api/pulse

`build.mjs` czyta `problems/`, `README.md` i `index.json` **względem katalogu
bieżącego**. Odpalony po ścieżce absolutnej z `/opt/exit0-src` sprawdza więc
źródła, a nie rejestr — i wypisuje pewne siebie `OK` o zupełnie innym drzewie. Ta
sekcja zostawia cię w `/opt/exit0-src` (poprzednia komenda to `cd`), dlatego
`cd` powyżej jest częścią sprawdzenia, a nie ozdobą.

## Zdrowie

Trzy rzeczy, w tej kolejności:

    git --no-optional-locks -C /srv/exit0 status --porcelain   # MUSI być pusto
    curl -s localhost:8080/api/pulse                 # writes: "ok", head się zmienia po zapisie
    systemctl status exit0

`--no-optional-locks` nie jest ozdobnikiem: zwykły `git status` **odświeża indeks**,
czyli bierze `.git/index.lock`, i pętla takiego sprawdzenia konkuruje z commitem
serwera. Serwer to przeżywa (ponawia, a gdy się nie uda — 503 z `retry-after`, bez
utraty zapisu), ale bez tej flagi sam sygnał zdrowia niepotrzebnie odrzuca cudze zapisy.

`writes: "readonly"` oznacza, że serwer przyjmuje odczyty i odrzuca zapisy z 503. To
samo widać w widoku tekstowym: `curl -s localhost:8080/ | grep UWAGA` pokazuje wtedy
linię `UWAGA zapisy wstrzymane`. Powód jest w polu `reason`, a gotowa komenda naprawcza
w polu `fix` — zarówno w ciele 503, jak i w `/api/pulse`. Powody:

| `reason` | Sprawdzenie | Naprawa |
|---|---|---|
| `git nie ma tozsamosci do commitowania` | `sudo -u exit0 git -C /srv/exit0 var GIT_COMMITTER_IDENT` | `git -C /srv/exit0 config user.email registry@localhost` i `user.name exit0` |
| `to nie jest repozytorium git` | `ls -d /srv/exit0/.git` | katalog nie pochodzi z instalatora — odtwórz z lustra (`Odtworzenie`) |
| `drzewo robocze jest brudne` | `git -C /srv/exit0 status --short` | patrz `Awarie` |
| `sprzatanie po nieudanym zapisie nie doszlo do skutku` | `git -C /srv/exit0 status --short` | `git checkout HEAD -- problems README.md index.json && git clean -fd -- problems`; sprawdź w logu, dlaczego git był zajęty |
| `rejestr jest niespojny` | `(cd /srv/exit0 && node scripts/build.mjs --check)` | popraw wskazany plik i przebuduj albo cofnij commit |
| `blokada zapisu jest zajeta` | `cat /srv/exit0/.state/write.lock`, potem `ps -p <pid>` | jeśli proces nie żyje albo to nie ten serwer: `rm /srv/exit0/.state/write.lock` |
| `plik blokady zapisu jest uszkodzony` | `cat /srv/exit0/.state/write.lock` | `rm /srv/exit0/.state/write.lock` |
| `licznik limitow jest nieczytelny` | `cat /srv/exit0/.state/limits.json /srv/exit0/.state/ip.json` | skasuj wskazany plik — limity dobowe startują wtedy od zera |
| `git moze przepisac bajty dowodow` | `git -C /srv/exit0 check-attr text -- problems/evidence/0000-probe.txt` | przywróć `.gitattributes` z linią `problems/evidence/** -text` i zacommituj |
| `git w tym katalogu jest zajety (.git/index.lock)` | `ls -l /srv/exit0/.git/index.lock`, potem `ps aux \| grep '[g]it'` | jeśli żaden git nie pracuje: `sudo rm /srv/exit0/.git/index.lock` — patrz `Awarie` |
| `nie moge pisac do .state/` | `sudo -u exit0 touch /srv/exit0/.state/probe`, `df -h /srv`, `ls -ld /srv/exit0/.state` | przywróć prawa (`chown -R exit0 /srv/exit0/.state`) albo zwolnij miejsce na dysku |

Serwer sprawdza stan przy każdym **odczycie** (tania próbka: `HEAD`, brud w drzewie,
blokada, liczniki — z sufitem raz na sekundę) i wymusza pełne sprawdzenie przy każdej
próbie zapisu, więc wychodzi z trybu read-only sam, w ciągu ~sekundy od usunięcia
przyczyny. Restart nie jest potrzebny i nie pomoże, jeśli przyczyna została.

Gdy `reason` mówi o brudnym drzewie, `/api/pulse` dokłada `"source": "HEAD"`, a widok
tekstowy linię `widok pochodzi z HEAD`. To znaczy, że odczyty **omijają drzewo robocze**
i podają stan z ostatniego commita: w drzewie może leżeć zapis, którego nie ma w gicie,
a taki stan z definicji nie istnieje (niezmiennik 1).

## Awarie

**Brudne drzewo po przerwanym zapisie.** Serwer commituje tylko kompletne zapisy, więc
niezacommitowana zmiana to śmieć po przerwanym żądaniu. Obejrzyj, potem cofnij:

    git -C /srv/exit0 status --short
    git -C /srv/exit0 diff
    sudo systemctl stop exit0
    cd /srv/exit0
    sudo -u exit0 git reset -q -- problems README.md index.json
    sudo -u exit0 git checkout HEAD -- problems README.md index.json
    sudo -u exit0 git clean -fd -- problems
    node scripts/build.mjs --check
    sudo systemctl start exit0

To jest ta sama sekwencja, którą serwer wykonuje sam po odrzuconym zapisie (`reset`,
`checkout HEAD`, `clean`). `reset` jest pierwszy nieprzypadkowo: bez niego plik dodany do
indeksu przez przerwany zapis przeżyłby oba pozostałe kroki.

**Zapisy zwracają 503 „inny proces pisze do tego katalogu”.** Blokada to
`/srv/exit0/.state/write.lock` z pid-em właściciela. Serwer sam przejmuje
blokadę po martwym procesie i nigdy po żywym. Jeśli plik został po ubitym `-9`
procesie, a `ps` nic nie pokazuje:

    cat /srv/exit0/.state/write.lock          # sprawdź pid
    sudo systemctl stop exit0
    sudo rm /srv/exit0/.state/write.lock
    sudo systemctl start exit0

Nie musisz zgadywać, czy to ten przypadek: `/api/pulse` mówi wtedy
`"reason": "blokada zapisu jest zajeta"` i podaje tę samą komendę w polu `fix`.

**Zapisy zwracają 503 „git w tym katalogu jest zajety (.git/index.lock)”.** To jest
zaległy zamek gita — zostaje po przerwanym `git add`/`git commit` albo po `kill -9` na
czymkolwiek, co dotykało indeksu. Serwer czeka na niego do sekundy i **nie stosuje
zapisu**, dopóki zamka nie ma, więc drzewo zostaje czyste, a autor dostaje 503 z
`retry-after`, nie utracony zapis. Sprawdź, czy naprawdę nikt nie pracuje, i usuń:

    ls -l /srv/exit0/.git/index.lock
    ps aux | grep '[g]it'
    sudo rm /srv/exit0/.git/index.lock

Zapisy wracają od następnego żądania — bez restartu. Nie musisz zgadywać, czy to
ten przypadek: `/api/pulse` mówi wtedy `"writes": "readonly"` z `reason` nazywającym
`.git/index.lock`. Serwer sam tego zamka **nie usuwa** — cudzy, żywy `git` ma prawo go
trzymać, a odebranie mu zamka rozjechałoby indeks. Ścieżka zapisu daje mu sekundę
(kolizja bywa przelotna) i dopiero potem odsyła 503 z `retry-after`.

**Zapisy zwracają 503 „nie moge pisac do .state/" albo „nie moge zapisac do
problems/".** To jest awaria nośnika, nie treści żądania: pełny dysk, wolumen
przemontowany tylko do odczytu albo rozjazd praw po ręcznej edycji. Rejestr sam z tego
wychodzi, gdy przyczyna zniknie — nie trzeba restartu:

    df -h /srv
    ls -ld /srv/exit0/.state /srv/exit0/problems
    sudo -u exit0 touch /srv/exit0/.state/probe && sudo -u exit0 rm /srv/exit0/.state/probe
    sudo chown -R exit0:exit0 /srv/exit0

Odrzucony w ten sposób zapis niczego nie zostawia — serwer sprząta po sobie tak samo
jak po odrzuceniu przez walidator. Jeśli mimo to `git status --porcelain` pokazuje
nieśledzony plik w `problems/evidence/`, to jest ślad po awarii sprzed tej naprawy:
`git clean -fd -- problems`.

**Każdy zapis pada, odczyty działają.** Najczęściej `node` nie jest w `PATH`
jednostki — serwer woła `node scripts/build.mjs` po nazwie. Sprawdź, co instalator
wyrenderował, i porównaj z prawdą:

    grep -E "^(ExecStart|Environment=PATH)" /etc/systemd/system/exit0.service
    command -v node

Rozjazd naprawia ponowne `sudo deploy/install.sh` — unit jest renderowany z
`command -v node`, nie z zaszytej ścieżki.

**Wszyscy dostają 429.** Limit po IP liczy się dla adresu, który poda proxy. Sprawdź, że
Caddy nadpisuje nagłówek (`header_up X-Forwarded-For {remote_host}`) i że unit ma
`TRUST_PROXY=1`. Przy odwrotnym ustawieniu cały ruch wpada do jednego kubełka
`127.0.0.1` i wspólnie zjada dobowy limit.

**Usługa się restartuje w pętli.** `journalctl -u exit0 -n 100`. Niespójne repo
nie powinno tego robić (od tego jest tryb read-only), więc pętla oznacza błąd startu:
brak `scripts/`, brak praw do katalogu, złe `ExecStart` albo zła wartość `PORT` lub
`IP_CAP` w `Environment=`. Ta ostatnia mówi sama za siebie — `PORT="" nie jest liczbą
całkowitą z zakresu 0-65535` — i jest celowo błędem startu: pusty `PORT` znaczyłby dla
Node port 0, więc usługa wstałaby zdrowa na losowym porcie, którego Caddy nie dosięga,
a `IP_CAP` spoza zakresu odrzucałby każdy zapis z 429 bez jednej linii w logu.

**Zabija ją OOM.** Unit ma `MemoryMax=256M`. Zmierzone przy jednym problemie: serwer
w spoczynku ~55 MB, `build.mjs` w szczycie ~49 MB, a przy zapisie chodzą oba naraz plus
`git`. Zapas jest, ale `build.mjs` czyta wszystkie problemy i wszystkie dowody, więc
zapotrzebowanie rośnie razem z rejestrem — to jest ta jedna liczba w unicie, którą kiedyś
trzeba będzie podnieść. Bieżące zużycie razem z limitem pokazuje linia `Memory:`
w `systemctl status exit0`.

## Zatrzymanie i deinstalacja

    sudo systemctl disable --now exit0
    sudo rm /etc/systemd/system/exit0.service
    sudo systemctl daemon-reload
    # dane zostają w /srv/exit0 — to jest cały rejestr, skasuj świadomie
