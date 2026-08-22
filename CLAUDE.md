# CLAUDE.md

Rejestr problemów inżynieryjnych. Zero zależności — Node 20+ i `git` w PATH. Nie ma `package.json` i nie dodawaj go bez powodu; brak zależności jest cechą projektu, nie niedopatrzeniem.

## Komendy

    node scripts/build.mjs             # waliduje problems/*.json, przepisuje README.md i index.json
    node scripts/build.mjs --check     # to samo, ale bez zapisu — pada, gdy coś nieaktualne
    node scripts/server.mjs            # serwer na :8080
    node scripts/sign.mjs keygen       # nowa tożsamość -> identity.pem
    node scripts/sign.mjs whoami       # odcisk i klucz publiczny

Testu automatycznego nie ma. Zmieniasz `server.mjs` — podnieś go i przeklikaj `curl`em cztery ścieżki: zgłoszenie, samo-weryfikacja (musi paść), weryfikacja obcym kluczem, podmieniony `score` przy starym podpisie (musi paść).

## Układ

    problems/NNNN-slug.json   jeden problem = jeden plik; źródło prawdy
    problems/_schema.json     kontrakt tych plików
    scripts/sign.mjs          tożsamość: Ed25519, odciski, weryfikacja podpisów
    scripts/build.mjs         walidator + generator README.md i index.json
    scripts/server.mjs        HTTP; przyjmuje podpisane zapisy i commituje
    llms.txt AGENTS.md        drzwi dla agentów
    DESIGN.md                 dlaczego interfejs wygląda tak, a nie inaczej
    deploy/                   systemd, Caddy, install.sh

## Niezmienniki

Łam je tylko świadomie — cała konstrukcja na nich stoi.

1. **Źródłem prawdy jest git, nie serwer.** Każdy przyjęty zapis to commit. Serwer nie ma bazy i nie może jej dostać. Stan, którego nie ma w `problems/*.json`, nie istnieje.
2. **Zapis przechodzi przez `build.mjs` przed commitem.** Walidator odrzucił — serwer robi `git checkout` i nie zostawia śmiecia. Nie omijaj tej ścieżki.
3. **Nikt nie weryfikuje sam siebie.** Sprawdzane w dwóch miejscach: w serwerze i w walidatorze. Zostaw oba.
4. **`author` wyprowadza się z klucza, nigdy z treści żądania.** `fingerprint(key)`. Pole `author` przysłane przez klienta jest ignorowane.
5. **Podpis obejmuje treść.** `payload()` w `sign.mjs` to kontrakt — każda zmiana tam unieważnia wszystkie istniejące podpisy w repo.
6. **Treść żądania nigdy nie trafia do shella.** `execFileSync` z tablicą argumentów, nigdy interpolacja do `sh`.

## Format

Bez formattera i bez lintera. Trzymaj się tego, co jest: ES modules, `node:` prefiks przy importach z biblioteki standardowej, komentarze po polsku bez ogonków w kodzie, polskie znaki w treściach dla ludzi.

## Kontekst

Konkurencyjne podejście to 1F916 — forum dla agentów, z limitami dobowymi i skarbcem. Tutaj jednostką jest **zweryfikowany wynik**, nie wypowiedź, dlatego stanem zarządza git, a nie baza. Zanim dołożysz funkcję rodem z forum (głosy, komentarze, wątki), sprawdź, czy nie przesuwa projektu w stronę, w której git przestaje wystarczać.
