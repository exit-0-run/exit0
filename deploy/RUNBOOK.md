# RUNBOOK

Operacyjna instrukcja dla `/srv/open-problems`. Instalator: `deploy/install.sh`.
Reguła nadrzędna: **źródłem prawdy jest git w katalogu usługi**, a nie proces. Jeśli
masz kopię tego katalogu, masz cały rejestr.

## Instalacja

    git clone <repo> /opt/open-problems-src
    cd /opt/open-problems-src
    sudo deploy/install.sh

Skrypt: sprawdza node 20+, zakłada użytkownika `openproblems`, kopiuje kod do
`/srv/open-problems`, zasiewa `problems/` i `README.md` (tylko gdy ich tam nie ma),
buduje, commituje, renderuje unit pod wykrytą ścieżkę node, startuje usługę i czeka na
`/api/pulse`. Kończy się niezerowo, jeśli serwer nie odpowie — „gotowe” znaczy
„odpowiada”.

TLS:

    cp /srv/open-problems/deploy/Caddyfile /etc/caddy/Caddyfile
    # podmień `open-problems.example` na swoją domenę
    systemctl reload caddy

Zmienne, które instalator honoruje: `DIR`, `UNIT_DIR`, `SVC_USER`, `SVC_GROUP`, `PORT`.
Zmiana portu to `sudo PORT=9090 deploy/install.sh` **plus** poprawiony `reverse_proxy`
w Caddyfile.

## Aktualizacja

    cd /opt/open-problems-src
    git pull
    sudo deploy/install.sh

To jest cała procedura. Instalator sam zatrzymuje usługę, podmienia **wyłącznie kod**
(`scripts/`, `deploy/`, `llms.txt`, dokumenty, `problems/_schema.json`), przebudowuje,
commituje efekt i startuje z powrotem.

**Nigdy nie rób `git pull` w `/srv/open-problems`.** Historia tego katalogu to historia
rejestru, a nie historia kodu — to dwa różne repozytoria, które nie mają wspólnego
przodka.

Instalator odmówi pracy, jeśli zastanie tam niezacommitowane zmiany. To celowe: takie
zmiany to albo ręczna edycja w toku, albo przerwany zapis. Rozwiąż je (`Awarie`) i
powtórz.

## Kopia zapasowa

Kopia to `git push --mirror`. Najpierw skonfiguruj zdalne repozytorium raz, ręcznie —
instalator tego nie zgaduje:

    # klucz wdrożeniowy roota musi mieć prawo zapisu do lustra
    git -C /srv/open-problems remote add mirror git@twoj-host:ty/open-problems-backup.git
    git -C /srv/open-problems push --mirror mirror     # pierwszy raz ręcznie, żeby zobaczyć błąd

Potem cron:

    # /etc/cron.d/open-problems-backup
    17 * * * * root git -C /srv/open-problems push --mirror mirror || logger -t open-problems "kopia zapasowa nie poszla"

Czego **nie** backupujemy: `.state/` (liczniki dobowe i lockfile — celowo ulotne,
skasowanie ich zeruje limity) oraz `identity.pem`, którego serwer w ogóle nie ma.

Nie trzymaj w `/srv/open-problems` niczego swojego: zrzutu bazy, archiwum, kluczy SSH.
Katalog domowy użytkownika usługi wskazuje na to samo miejsce, więc `~/.ssh` też się tu
liczy. Każdy nieśledzony plik to dla serwera brudne drzewo, czyli **zatrzymane zapisy**
(`.gitignore` zwalnia z tego tylko `.state/`, `identity.pem` i `node_modules/`).

Katalog `problems/evidence/` rośnie z ruchem i jako jedyny nie da się odtworzyć z
niczego innego. Pilnuj rozmiaru: `du -sh /srv/open-problems/problems/evidence`.

## Odtworzenie

    git clone <lustro> /srv/open-problems
    cd /opt/open-problems-src && sudo deploy/install.sh

Klon przynosi dane i historię; instalator dokłada kod, tożsamość gita, unit i start.
Ponieważ świeży klon jest czysty, kontrola „niezacommitowane zmiany” przechodzi.

Sanity check po odtworzeniu — **z katalogu rejestru**, nie ze źródeł:

    (cd /srv/open-problems && node scripts/build.mjs --check)
    curl -s localhost:8080/api/pulse

`build.mjs` czyta `problems/`, `README.md` i `index.json` **względem katalogu
bieżącego**. Odpalony po ścieżce absolutnej z `/opt/open-problems-src` sprawdza więc
źródła, a nie rejestr — i wypisuje pewne siebie `OK` o zupełnie innym drzewie. Ta
sekcja zostawia cię w `/opt/open-problems-src` (poprzednia komenda to `cd`), dlatego
`cd` powyżej jest częścią sprawdzenia, a nie ozdobą.

## Zdrowie

Trzy rzeczy, w tej kolejności:

    git --no-optional-locks -C /srv/open-problems status --porcelain   # MUSI być pusto
    curl -s localhost:8080/api/pulse                 # writes: "ok", head się zmienia po zapisie
    systemctl status open-problems

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
| `git nie ma tozsamosci do commitowania` | `sudo -u openproblems git -C /srv/open-problems var GIT_COMMITTER_IDENT` | `git -C /srv/open-problems config user.email registry@localhost` i `user.name open-problems` |
| `to nie jest repozytorium git` | `ls -d /srv/open-problems/.git` | katalog nie pochodzi z instalatora — odtwórz z lustra (`Odtworzenie`) |
| `drzewo robocze jest brudne` | `git -C /srv/open-problems status --short` | patrz `Awarie` |
| `sprzatanie po nieudanym zapisie nie doszlo do skutku` | `git -C /srv/open-problems status --short` | `git checkout HEAD -- problems README.md index.json && git clean -fd -- problems`; sprawdź w logu, dlaczego git był zajęty |
| `rejestr jest niespojny` | `(cd /srv/open-problems && node scripts/build.mjs --check)` | popraw wskazany plik i przebuduj albo cofnij commit |
| `blokada zapisu jest zajeta` | `cat /srv/open-problems/.state/write.lock`, potem `ps -p <pid>` | jeśli proces nie żyje albo to nie ten serwer: `rm /srv/open-problems/.state/write.lock` |
| `plik blokady zapisu jest uszkodzony` | `cat /srv/open-problems/.state/write.lock` | `rm /srv/open-problems/.state/write.lock` |
| `licznik limitow jest nieczytelny` | `cat /srv/open-problems/.state/limits.json /srv/open-problems/.state/ip.json` | skasuj wskazany plik — limity dobowe startują wtedy od zera |
| `git moze przepisac bajty dowodow` | `git -C /srv/open-problems check-attr text -- problems/evidence/0000-probe.txt` | przywróć `.gitattributes` z linią `problems/evidence/** -text` i zacommituj |
| `git w tym katalogu jest zajety (.git/index.lock)` | `ls -l /srv/open-problems/.git/index.lock`, potem `ps aux \| grep '[g]it'` | jeśli żaden git nie pracuje: `sudo rm /srv/open-problems/.git/index.lock` — patrz `Awarie` |
| `nie moge pisac do .state/` | `sudo -u openproblems touch /srv/open-problems/.state/probe`, `df -h /srv`, `ls -ld /srv/open-problems/.state` | przywróć prawa (`chown -R openproblems /srv/open-problems/.state`) albo zwolnij miejsce na dysku |

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

    git -C /srv/open-problems status --short
    git -C /srv/open-problems diff
    sudo systemctl stop open-problems
    cd /srv/open-problems
    sudo -u openproblems git reset -q -- problems README.md index.json
    sudo -u openproblems git checkout HEAD -- problems README.md index.json
    sudo -u openproblems git clean -fd -- problems
    node scripts/build.mjs --check
    sudo systemctl start open-problems

To jest ta sama sekwencja, którą serwer wykonuje sam po odrzuconym zapisie (`reset`,
`checkout HEAD`, `clean`). `reset` jest pierwszy nieprzypadkowo: bez niego plik dodany do
indeksu przez przerwany zapis przeżyłby oba pozostałe kroki.

**Zapisy zwracają 503 „inny proces pisze do tego katalogu”.** Blokada to
`/srv/open-problems/.state/write.lock` z pid-em właściciela. Serwer sam przejmuje
blokadę po martwym procesie i nigdy po żywym. Jeśli plik został po ubitym `-9`
procesie, a `ps` nic nie pokazuje:

    cat /srv/open-problems/.state/write.lock          # sprawdź pid
    sudo systemctl stop open-problems
    sudo rm /srv/open-problems/.state/write.lock
    sudo systemctl start open-problems

Nie musisz zgadywać, czy to ten przypadek: `/api/pulse` mówi wtedy
`"reason": "blokada zapisu jest zajeta"` i podaje tę samą komendę w polu `fix`.

**Zapisy zwracają 503 „git w tym katalogu jest zajety (.git/index.lock)”.** To jest
zaległy zamek gita — zostaje po przerwanym `git add`/`git commit` albo po `kill -9` na
czymkolwiek, co dotykało indeksu. Serwer czeka na niego do sekundy i **nie stosuje
zapisu**, dopóki zamka nie ma, więc drzewo zostaje czyste, a autor dostaje 503 z
`retry-after`, nie utracony zapis. Sprawdź, czy naprawdę nikt nie pracuje, i usuń:

    ls -l /srv/open-problems/.git/index.lock
    ps aux | grep '[g]it'
    sudo rm /srv/open-problems/.git/index.lock

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
    ls -ld /srv/open-problems/.state /srv/open-problems/problems
    sudo -u openproblems touch /srv/open-problems/.state/probe && sudo -u openproblems rm /srv/open-problems/.state/probe
    sudo chown -R openproblems:openproblems /srv/open-problems

Odrzucony w ten sposób zapis niczego nie zostawia — serwer sprząta po sobie tak samo
jak po odrzuceniu przez walidator. Jeśli mimo to `git status --porcelain` pokazuje
nieśledzony plik w `problems/evidence/`, to jest ślad po awarii sprzed tej naprawy:
`git clean -fd -- problems`.

**Każdy zapis pada, odczyty działają.** Najczęściej `node` nie jest w `PATH`
jednostki — serwer woła `node scripts/build.mjs` po nazwie. Sprawdź, co instalator
wyrenderował, i porównaj z prawdą:

    grep -E "^(ExecStart|Environment=PATH)" /etc/systemd/system/open-problems.service
    command -v node

Rozjazd naprawia ponowne `sudo deploy/install.sh` — unit jest renderowany z
`command -v node`, nie z zaszytej ścieżki.

**Wszyscy dostają 429.** Limit po IP liczy się dla adresu, który poda proxy. Sprawdź, że
Caddy nadpisuje nagłówek (`header_up X-Forwarded-For {remote_host}`) i że unit ma
`TRUST_PROXY=1`. Przy odwrotnym ustawieniu cały ruch wpada do jednego kubełka
`127.0.0.1` i wspólnie zjada dobowy limit.

**Usługa się restartuje w pętli.** `journalctl -u open-problems -n 100`. Niespójne repo
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
w `systemctl status open-problems`.

## Zatrzymanie i deinstalacja

    sudo systemctl disable --now open-problems
    sudo rm /etc/systemd/system/open-problems.service
    sudo systemctl daemon-reload
    # dane zostają w /srv/open-problems — to jest cały rejestr, skasuj świadomie
