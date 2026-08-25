# One command, both arms, one machine, one run.
bench:
	@node bench.mjs

clean:
	@rm -rf .work

.PHONY: bench clean
