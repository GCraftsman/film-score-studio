# AI music legal-safety controls

> Informational only; this is not legal advice.

Film Score Studio is designed to help create original score material, not to
imitate identifiable people or reproduce protected expression. Human authorship
matters: the U.S. Copyright Office explains that prompts alone generally do not
provide sufficient control for copyright authorship. Style by itself is generally
not protected by copyright, but substantially similar protected expression can
still create risk. Training and licensing questions remain fact-specific and
active subjects of litigation. Voice and identity requests can also raise
publicity, false-endorsement, and digital-replica concerns.

Avoiding a name does **not** guarantee non-infringement. Composers should use
their own judgment and obtain appropriate legal advice for a release.

## Implementation controls

- `src/lib/ai-music-safety.ts` is the single policy source used at every model
  call. Its prompt policy prohibits named-reference imitation and recognizable
  melodies, lyrics, signature motifs, and protected recordings.
- Before routing, one low-token semantic xAI safety-normalizer (itself governed
  by the central policy) converts raw user directions and history to neutral
  material. Deterministic suspicious imitation, quoted-title, proper-name, and
  supplemental phonetic-regression checks provide a second boundary. Raw
  blocked text is therefore not placed in routing or specialist prompts.
- Specialist questions and responses are screened before they can reach another
  model or the composer. A single low-token final compliance rewrite plus the
  deterministic egress guard protect the Orchestrator response; operation
  display text receives the same conservative screening.
- If parsing or screening cannot safely preserve text, the service returns a
  generic, neutral musical fallback rather than forwarding the unsafe material.
  Structured score validation remains independent of these text controls.

## Copyright Office resources

- [Copyright and Artificial Intelligence](https://copyright.gov/ai)
- [Part 1: Digital Replicas](https://copyright.gov/ai/Copyright-and-Artificial-Intelligence-Part-1-Digital-Replicas-Report.pdf)
- [Part 2: Copyrightability](https://copyright.gov/ai/Copyright-and-Artificial-Intelligence-Part-2-Copyrightability-Report.pdf)
- [Part 3: Generative AI Training](https://copyright.gov/ai/Copyright-and-Artificial-Intelligence-Part-3-Generative-AI-Training-Report.pdf)