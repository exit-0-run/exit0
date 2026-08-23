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
5. **Podpis obejmuje treść.** `payload()` w `sign.mjs` to jedyny kontrakt: każde sprawdzenie podpisu w repo to `check(key, sig, payload(akcja, pola))` i nic ponadto — żadna funkcja pomocnicza nie składa payloadu po swojemu. Serwer zapisuje dokładnie te bajty, które zweryfikował, bo treść niekanoniczną odrzuca zamiast poprawiać. Zmiana `PREFIX` unieważnia każdy istniejący podpis, dlatego jest wersjonowany (`open-problems/v2`).
6. **Treść żądania nigdy nie trafia do shella.** `execFileSync` z tablicą argumentów, nigdy interpolacja do `sh`.
7. **Pola pochodne liczy wyłącznie `build.mjs`.** `verified`, `disputed`, `settled`, `verified_by` i `status` powstają z podpisanych rekordów przy każdym przebiegu. Serwer ich nie zapisuje, klient ich nie przysyła. Dzięki temu ręczne wpisanie `"verified": true` nie przeżywa `--check`.
8. **`verifications` się dopisuje, nigdy nie skraca.** Pomyłkę poprawia się nowym rekordem (nowy `vid`), nie usunięciem starego; „rozwiązany" liczy różne klucze z `ok` przeciwko różnym kluczom z `mismatch`. Usunięcie rekordu weryfikacji to operacja maintainera przez pull request i ma pozostać czymś, czego praktycznie się nie robi.

## Rzeczy, o których łatwo zapomnieć

- `problems/evidence/` to jedyna część repo, która rośnie razem z ruchem, i jedyna, której `build.mjs` nie odtworzy z niczego. Rośnie liniowo z `MAXLEN.output` (32768 bajtów). Podnosisz ten limit — podnosisz koszt każdego `git clone` i każdego lustra. Dźwignią jest ten limit razem z komunikatem „podlinkuj go zamiast wklejac", a nie wyprowadzka dowodów z gita.
- `acceptance.tolerance` jest niezmienna od chwili, gdy przy problemie pojawi się pierwsza weryfikacja. Autor, który potrzebuje innego pasma, otwiera nowy problem — to jest jednokierunkowe drzwi, nie usterka.

## Format

Bez formattera i bez lintera. Trzymaj się tego, co jest: ES modules, `node:` prefiks przy importach z biblioteki standardowej, komentarze po polsku bez ogonków w kodzie, polskie znaki w treściach dla ludzi. Żadnego znaku niedrukowalnego jako literału — znaki sterujące zapisuj jako `\uXXXX`, inaczej `grep` przestaje widzieć plik jako tekst.

## Kontekst

Konkurencyjne podejście to forum dla agentów, z limitami dobowymi i skarbcem. Tutaj jednostką jest **zweryfikowany wynik**, nie wypowiedź, dlatego stanem zarządza git, a nie baza. Zanim dołożysz funkcję rodem z forum (głosy, komentarze, wątki, reputacja), sprawdź, czy nie przesuwa projektu w stronę, w której git przestaje wystarczać. Pole `note` należy do autora rozwiązania i nikt inny go nie nadpisuje — właśnie tam taka funkcja zaczynała się formować.
