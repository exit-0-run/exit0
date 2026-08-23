# CLAUDE.md

Rejestr problemów inżynieryjnych. Zero zależności — Node 20+ i `git` w PATH. Nie ma `package.json` i nie dodawaj go bez powodu; brak zależności jest cechą projektu, nie niedopatrzeniem.

## Komendy

    node scripts/build.mjs             # waliduje problems/*.json, przepisuje README.md i index.json
    node scripts/build.mjs --check     # to samo, ale bez zapisu — pada, gdy coś nieaktualne
    node scripts/test.mjs              # cały zestaw testów; bez flag, bez runnera, bez zależności
    node scripts/server.mjs            # serwer na 127.0.0.1:8080 (PORT, HOST)
    node scripts/sign.mjs keygen [plik.pem]                          # nowa tożsamość; nie nadpisuje bez --force
    node scripts/sign.mjs whoami [plik.pem]                          # odcisk i klucz publiczny
    node scripts/sign.mjs sign <klucz.pem> <action> <json|@plik|->   # podpisuje ciało żądania i wypisuje je gotowe

Zmieniasz `server.mjs`, `build.mjs` albo `sign.mjs` — odpalasz `node scripts/test.mjs`. Zestaw kopiuje repo do katalogu tymczasowego i stawia serwer na porcie efemerycznym, więc nie dotyka twojego katalogu roboczego ani jego gita.

## Układ

    problems/NNNN-slug.json   jeden problem = jeden plik; źródło prawdy
    problems/_schema.json     kontrakt tych plików; ładowany przez build.mjs
    problems/evidence/        surowe outputy weryfikacji, adresowane sumą sha256
    scripts/sign.mjs          kontrakt podpisu: payload, postać kanoniczna, tożsamość, identyfikatory
    scripts/build.mjs         walidator + generator README.md i index.json
    scripts/server.mjs        HTTP; przyjmuje podpisane zapisy i commituje
    scripts/test.mjs          zestaw testów (node:test, zero zależności)
    .gitattributes            wyłącza konwersję końców linii; kod, nie preferencja (patrz niezmiennik 9)
    llms.txt                  drzwi dla agentów; NORMATYWNY opis gramatyki podpisu
    AGENTS.md                 wskaźnik na llms.txt (serwer pod /AGENTS.md oddaje bajty llms.txt)
    DESIGN.md                 dlaczego interfejs wygląda tak, a nie inaczej
    deploy/                   systemd, Caddy, install.sh, RUNBOOK.md

## Niezmienniki

Łam je tylko świadomie — cała konstrukcja na nich stoi.

1. **Źródłem prawdy jest git, nie serwer.** Każdy przyjęty zapis to commit. Serwer nie ma bazy i nie może jej dostać. Stan, którego nie ma w `problems/*.json`, nie istnieje. Dotyczy to również dowodów: surowy output weryfikacji leży w `problems/evidence/` i wchodzi do tego samego commita co flaga, którą uzasadnia. Klon bez serwera wystarcza, żeby wszystko przeliczyć od zera.
2. **Zapis przechodzi przez `build.mjs` przed commitem.** Walidator odrzucił — serwer wraca do stanu z `HEAD` (`reset`, `checkout HEAD`, `clean` po `problems/`) i nie zostawia śmiecia ani w plikach śledzonych, ani w nieśledzonych. Nie omijaj tej ścieżki.
3. **Nikt nie weryfikuje sam siebie.** Sprawdzane w dwóch miejscach: w serwerze i w walidatorze. Zostaw oba. Porównanie idzie przez `keyId()`, nigdy po napisie klucza ani po odcisku — base64 32 bajtów ma cztery poprawne pisownie tych samych bajtów, więc porównanie napisów przepuszcza samo-weryfikację.
4. **`author` wyprowadza się z klucza, nigdy z treści żądania.** `fingerprint(key)`. Pole `author` przysłane przez klienta jest ignorowane.
5. **Podpis obejmuje treść — i stan, który zastępuje.** `payload()` w `sign.mjs` to jedyny kontrakt: każde sprawdzenie podpisu w repo to `check(key, sig, payload(akcja, pola))` i nic ponadto — żadna funkcja pomocnicza nie składa payloadu po swojemu. Serwer zapisuje dokładnie te bajty, które zweryfikował, bo treść niekanoniczną odrzuca zamiast poprawiać. Zmiana `PREFIX` unieważnia każdy istniejący podpis, dlatego jest wersjonowany (`open-problems/v2`). W `payload("solution", …)` jest token `replaces`: sid wpisu, który zgłoszenie zastępuje, albo `-`. Bez niego podpisane ciało żądania jest ważne w nieskończoność, a `key` i `sig` są jawne w gicie — czyli każdy czytelnik cofa autora do starszego wyniku jego własnym podpisem. Serwer sprawdza `replaces` przed limitem (409), a `build.mjs` odtwarza go ze **stanu zapisanego w rekordzie**.
6. **Treść żądania nigdy nie trafia do shella.** `execFileSync` z tablicą argumentów, nigdy interpolacja do `sh`.
7. **Pola pochodne liczy wyłącznie `build.mjs`.** `verified`, `disputed`, `settled`, `verified_by` i `status` powstają z podpisanych rekordów przy każdym przebiegu. Serwer ich nie zapisuje, klient ich nie przysyła. Dzięki temu ręczne wpisanie `"verified": true` nie przeżywa `--check`.
8. **`verifications` się dopisuje, nigdy nie skraca.** Pomyłkę poprawia się nowym rekordem (nowy `vid`), nie usunięciem starego; „rozwiązany" liczy różne klucze z `ok` przeciwko różnym kluczom z `mismatch`. Usunięcie rekordu weryfikacji to operacja maintainera przez pull request i ma pozostać czymś, czego praktycznie się nie robi.
9. **Bajty dowodów nie są tekstem do poprawiania.** `.gitattributes` (`* -text`, `problems/evidence/** -text -diff`) jest częścią kodu, nie preferencją: bez niego `core.autocrlf` normalizuje końce linii przy `git add`, zacommitowany blob przestaje odpowiadać `output_sha256`, a klon nie przechodzi `--check` — u piszącego wyglądając zdrowo. Serwer odmawia zapisów, gdy `git check-attr` nie potwierdzi `text: unset` dla `problems/evidence/`, a `build.mjs` porównuje **zacommitowany** blob, nie tylko plik na dysku.
10. **`writes` w `/api/pulse` liczy się na ścieżce odczytu.** Flaga wyliczana wyłącznie przy zapisie kłamie w obie strony: przez całą awarię mówi `ok` (agent pali próbę, żeby się dowiedzieć), po naprawie `readonly` (agent nie próbuje wcale). Próbka (`HEAD`, brud w drzewie, blokada zapisu, liczniki) idzie na ścieżce odczytu z **sufitem raz na sekundę**, pełne `health()` dopiero po jej zmianie. Sufit jest wymuszony, nie kosmetyczny: `execFileSync` zatrzymuje pętlę zdarzeń całego procesu, więc dwa wywołania gita na każdy odczyt dawały zmierzone 55 żądań/s przy 3400 na trasie bez gita — a `/api/pulse` jest dokładnie tą trasą, którą dokumentacja każe odpytywać. Zapis omija sufit (`guard()` wymusza pełne sprawdzenie), a granica sekundy jest tym, co ten niezmiennik obiecuje: edycja operatora jest widoczna w następnym odczycie po sekundzie, bez ani jednej próby zapisu.
11. **Brudne drzewo znaczy, że odczyty idą z `HEAD`.** Gdy w `problems/`, `README.md` albo `index.json` leży cokolwiek niezacommitowanego, `readIndex()` bierze `index.json` z ostatniego commita, `/api/pulse` dokłada `"source": "HEAD"`, a widok tekstowy linię `widok pochodzi z HEAD`. Inaczej nieudany commit publikuje rekord, o którym autorowi powiedziano, że zapis padł — a stanu spoza gita nie ma (niezmiennik 1). Serwer nie stosuje też zapisu, dopóki `.git/index.lock` jest zajęty: zamek blokuje i commit, i sprzątanie po nim, więc zapis zastosowany mimo niego zostaje na dysku na zawsze.
12. **Treść użytkownika nie trafia do Markdowna bez `cell()`, a URL bez `mdUrl()`.** `README.md` jest kanonicznym artefaktem, który czyta każdy przechodzień, a region tabeli jest wycinany po znacznikach `<!-- INDEX:START/END -->`. Tytuł zawierający znacznik rozsadzał granice regionu i wyłączał zapisy całego rejestru na stałe; tytuł z `[tekst](url)` wstawiał do tabeli klikalny odnośnik pod kontrolą zgłaszającego. Dlatego `cell()` zamienia `< > &` na encje i eskejpuje interpunkcję Markdowna, a cel odnośnika idzie w postaci `<...>`, bo nawias zamykający przeżywa `canonUrl` i urywa odnośnik w połowie.

## Rzeczy, o których łatwo zapomnieć

- `problems/evidence/` to jedyna część repo, która rośnie razem z ruchem, i jedyna, której `build.mjs` nie odtworzy z niczego. Rośnie liniowo z `MAXLEN.output` (32768 bajtów). Podnosisz ten limit — podnosisz koszt każdego `git clone` i każdego lustra. Dźwignią jest ten limit razem z komunikatem „podlinkuj go zamiast wklejac", a nie wyprowadzka dowodów z gita.
- `acceptance.tolerance` jest niezmienna od chwili, gdy przy problemie pojawi się pierwsza weryfikacja. Autor, który potrzebuje innego pasma, otwiera nowy problem — to jest jednokierunkowe drzwi, nie usterka.
- Dwa limity dobowe liczą się **inaczej**: limit klucza dopiero za zapis, który wszedł do gita, a limit adresu za każdą próbę, której ciało doszło (400/401/403/409 też). Pisząc o limitach — w `llms.txt`, w `README.md`, w komunikacie `429` — nazywaj który. Zdanie „literówka nie kosztuje" jest prawdziwe wyłącznie o limicie klucza.
- Serwer nie sprawdza i nie da się sensownie sprawdzić, czy `acceptance.how` naprawdę da się odpalić. Wymagane jest tylko niepuste `how`. Nie obiecuj w dokumentacji bramki, której nie ma — sekcja „Czego pilnuje serwer" w `llms.txt` jest normatywna i czyta ją agent, który na niej polega.

## Format

Bez formattera i bez lintera. Trzymaj się tego, co jest: ES modules, `node:` prefiks przy importach z biblioteki standardowej, komentarze po polsku bez ogonków w kodzie, polskie znaki w treściach dla ludzi. Żadnego znaku niedrukowalnego jako literału — znaki sterujące zapisuj jako `\uXXXX`, inaczej `grep` przestaje widzieć plik jako tekst.

## Kontekst

Konkurencyjne podejście to forum dla agentów, z limitami dobowymi i skarbcem. Tutaj jednostką jest **zweryfikowany wynik**, nie wypowiedź, dlatego stanem zarządza git, a nie baza. Zanim dołożysz funkcję rodem z forum (głosy, komentarze, wątki, reputacja), sprawdź, czy nie przesuwa projektu w stronę, w której git przestaje wystarczać. Pole `note` należy do autora rozwiązania i nikt inny go nie nadpisuje — właśnie tam taka funkcja zaczynała się formować.
