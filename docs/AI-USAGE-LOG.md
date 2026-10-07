# AI usage log

**Status: DRAFT. The owner of this repository must read it, correct it to match what they personally did, and sign it off.** The brief asks for an honest log of what AI did and what you wrote yourself. A draft written by the assistant cannot say that for you.

## What I asked the AI tool to do

- Explain the task, estimate effort, and suggest a stack (Node + TypeScript backend, Vue for the page).
- Read the provided documents and applications, and work out the expected result of each application by hand.
- Generate the first implementation of: calculation functions, rules engine, policy edition selection, redaction, extraction verification, chunking, ingestion, the pipeline, Q&A, the API, the demo page, tests, the evaluation script, CI/Docker files and these documents.
- Run the tests, the evaluation and a local smoke test, and report the results.

## What I wrote or decided myself

> Fill this in honestly. Examples of things worth recording if true: which design decisions you made or changed in DESIGN.md, which parts you read line by line, what you modified, what you ran and observed yourself. Leave nothing here that you did not do.

- (to be completed by the repository owner)

## Cases where the AI was wrong, and how it was found

1. **Minimum-age rule.** The first version reused the _maximum-age-at-maturity_ function with a tenor of 0 to check "at least 21 years", which tests age <= 21 instead of >= 21. Found while reviewing the rules file before writing tests; fixed with a dedicated `minimumAgeRule` and a boundary test (21 on the day passes, one day short fails).
2. **Chunker dropped table rows.** The chunker discarded any clause whose chunk had no body line after its heading, which removed CP-3.4, CP-3.5 and CP-3.6 (one-line table rows). Found because every application came back as `evidence_missing: Clause CP-3.4 was not retrieved`; fixed so only bare top-level titles are dropped.
3. **Wrong expected maximum amount in the conversation.** An earlier explanation said APP-001's maximum eligible amount was 382,000. That is the 50% figure; under the 2025 policy (45%) it is 330,000. The brief's own Appendix E.2 contains the same inconsistency. Found by computing the 45% case in code and noticing the number did not match; recorded in DESIGN.md.
4. **Classic pitfall checked on purpose:** using the annual rate instead of the monthly rate in the installment formula gives a very different instalment; the worked-example test (8,630.39) pins the correct behaviour.
5. **A vacuous test risk.** A fairness test that always passes is worthless, so the redaction was deliberately broken once (title redaction removed) to confirm the test fails; it did, and the change was reverted.

## Not verified

The Gemini adapter and `docker compose` were not run. The evaluation ran on the offline mock provider.
