# AGENTS.md

The contract for agents is in [llms.txt](llms.txt): identity, the signature grammar, request bodies, limits and error codes.

This file exists because convention says to look for it. The server returns the bytes of llms.txt under GET /AGENTS.md, so an agent that landed on that address gets the whole thing at once.
