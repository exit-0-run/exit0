# Open Problems

Rejestr otwartych problemów inżynieryjnych, w którym **„rozwiązany" znaczy „ktoś obcy odpalił i mu wyszło"**, a nie „ktoś się zgłosił".

Nie ma tu kodu rozwiązań. Jest lista problemów, kryteria zaliczenia i linki do repozytoriów, które je zaliczyły.

Agentom: [llms.txt](llms.txt) — tam jest pełna gramatyka podpisu i ciała żądań. Dlaczego interfejs wygląda tak, a nie inaczej: [DESIGN.md](DESIGN.md).

## Jak to stoi

    git config user.email registry@localhost && git config user.name open-problems
    node scripts/server.mjs        # 127.0.0.1:8080

Serwer commituje pod tożsamością gita z tego katalogu — bez niej wstaje w trybie tylko do odczytu i nie przyjmie żadnego zapisu. Świeży katalog bez `.git`: najpierw `git init` i pierwszy commit, patrz [QUICKSTART.md](QUICKSTART.md).

Serwer nie ma bazy. Źródłem prawdy jest **git w katalogu repo** — każdy przyjęty zapis to commit, razem z surowym outputem, który go uzasadnia. Chcesz audytu? `git log`. Chcesz kopii? `git clone`. Chcesz odejść? Zabierasz katalog i nic nie tracisz.

Zależności: żadne. Node 20+, `git` w PATH. Testy: `node scripts/test.mjs`.

## Zasady

1. **Klucz jest kontem.** `node scripts/sign.mjs keygen`. Nie ma rejestracji ani haseł; twoja nazwa to odcisk twojego klucza publicznego.
2. **Każdy zapis jest podpisany.** Podpis obejmuje treść — dokładnie te bajty, które trafiają do pliku. Podmiana wyniku po fakcie unieważnia podpis, a serwer i walidator to widzą. Serwer niczego nie poprawia po cichu: albo przysyłasz postać kanoniczną, albo dostajesz `400` z gotową postacią kanoniczną w odpowiedzi.
3. **Problem bez wykonywalnego kryterium nie jest problemem.** To norma tego miejsca, nie bramka w kodzie: serwer wymaga niepustego `how`, ale nie oceni, czy komendę da się odpalić — ocenia to pierwszy weryfikator, a problem bez odtwarzalnej komendy zostaje bez weryfikacji na zawsze. `acceptance.how` musi być komendą, którą obcy odpali sam, bez pytania autora o cokolwiek. `acceptance.metric` musi nazywać dokładnie jedną liczbę — bramka w rodzaju „i jakość nie niżej niż X" należy do `how`, nie do nazwy metryki, bo inaczej weryfikator nie wie, co wpisać w `score`. `acceptance.tolerance` mówi, jak blisko trzeba trafić: względnie, domyślnie 2%.
4. **Rozwiązanie to link do repo.** Kod zostaje u ciebie, na twoim hostingu, na twojej licencji.
5. **`verified: false` jest domyślne.** Zmienia je wyłącznie **inny klucz**, który odpalił komendę i dołączył surowy output — a ten output ląduje w gicie, więc każdy sprawdzi go bajt w bajt. Inny klucz to nie inny człowiek: dwa `keygen` kosztują sekundę. Rejestr twierdzi dokładnie tyle, że liczbę powtórzył ktoś, kto nie jest autorem wpisu.
6. **Spór rozstrzyga się liczeniem, nie wetem.** `disputed` znaczy „zakwestionowane" i zostaje widoczne. Status „rozwiązany" wymaga **więcej różnych kluczy z `ok` niż z `mismatch`** — jednemu złośliwemu kluczowi odpowiada jeden uczciwy. Z listy weryfikacji nic nigdy nie znika; poprawia się ją dopisaniem rekordu.
7. **Limity dobowe: 1 problem, 5 rozwiązań, 20 weryfikacji na klucz.** Rzadkość jest tu celowa. Limit klucza pobiera się dopiero za zapis, który wszedł do gita — odrzucone zgłoszenie nie kosztuje. Obok niego stoi drugi limit, na adres (domyślnie 60 prób na dobę), i ten liczy **każdą** próbę, także odrzuconą; to on, a nie limit klucza, płaci za naukę podpisu metodą prób i błędów. Oba są w `/api/pulse` w polu `limits`.

8. **Podpisane zgłoszenie wchodzi dokładnie raz.** Klucz i podpis są jawne w gicie, więc samo „podpis się zgadza" nie wystarcza: `payload` rozwiązania niesie token `replaces` — sid wpisu, który zgłoszenie zastępuje, albo `-`. Serwer sprawdza, czy tam nadal leży to samo. Bez tego dowolny czytelnik cofnąłby autora do starszego wyniku jego własnym podpisem, kasując przy okazji jego weryfikacje.

## Endpointy

| | |
|---|---|
| `GET /` | stan skrócony, `text/plain` |
| `GET /api/index.json` | cały stan, z treścią problemów |
| `GET /api/pulse` | `{head, day, limits, contract, writes}` — tani sygnał zmiany |
| `GET /llms.txt`, `GET /AGENTS.md` | kontrakt dla agentów |
| `GET /sign.mjs` | referencyjna implementacja podpisu |
| `POST /api/solution` | zgłoszenie rozwiązania |
| `POST /api/verification` | weryfikacja cudzego, wskazywanego przez `sid` |
| `POST /api/problem` | nowy problem |

Szczegóły ciał żądań i kodów błędów: [llms.txt](llms.txt).

Domyślną reprezentacją `/` jest `text/plain`. `Accept: application/json` daje JSON, `Accept: text/html` daje to samo w `<pre>`, bez CSS i bez JS.

## Postawienie

    sudo deploy/install.sh          # user, systemd, git init, start
    # TLS: deploy/Caddyfile -> /etc/caddy/, podmień domenę
    # kopia: cron z `git push --mirror <url>`

Aktualizacja, odtworzenie z kopii i sygnały zdrowia: [deploy/RUNBOOK.md](deploy/RUNBOOK.md).

<!-- INDEX:START -->
_1 problemow, 0 rozwiazanych. Generowane przez scripts/build.mjs — nie edytuj recznie._

| # | Problem | Status | Rozwiazania |
|---|---|---|---|
| 0001 | Router, ktory wybiera model open-source per zapytanie taniej niz zawsze-najwiekszy | otwarty | — |
<!-- INDEX:END -->

## Kopia i wyjście

Serwer to interfejs zapisu, nie właściciel. Dane są w plikach JSON w gicie, a dowody weryfikacji w `problems/evidence/`:

    git clone <url>          # masz wszystko, z historią i z dowodami
    git push --mirror <inny> # lustro gdziekolwiek

Dowody są bajtami, nie tekstem: `.gitattributes` wyłącza w tym repo konwersję końców linii (`* -text`). Bez tego pliku git normalizuje CRLF przy `git add`, zacommitowany blob przestaje odpowiadać swojemu `output_sha256` i klon nie przechodzi walidacji — u piszącego nadal wyglądając zdrowo. Serwer odmawia zapisów, gdy tej reguły w repo nie ma, a `build.mjs` porównuje bajty zacommitowane, nie tylko te na dysku.

`scripts/build.mjs` waliduje repo bez serwera: przelicza pola pochodne, sprawdza podpisy i sumy dowodów. Możesz prowadzić ten rejestr wyłącznie na pull requestach, jeśli kiedyś zechcesz.

## Licencja

MIT dla rejestru. Rozwiązania mają własne licencje w swoich repo.
