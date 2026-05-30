import type { ReproInput } from "./oracle.js";

/**
 * The single networked entry point of the oracle layer: fetch a linked GitHub
 * issue's body so the issue-repro oracle has text to extract from. It is
 * networked, so it lives only in the live tier and is gated exactly like the
 * existing live runs. The deterministic core never imports this module; it
 * operates on a {@link ReproInput} that is either supplied directly or produced
 * here, so the hermetic suite never touches the network.
 */

interface IssueResponse {
  readonly body?: unknown;
}

/**
 * Fetch the body text of a GitHub issue over the network.
 *
 * @param owner - repository owner.
 * @param repo - repository name.
 * @param issueNumber - the issue number linked by the PR.
 * @param token - optional token to raise the rate limit; the public endpoint
 *   works unauthenticated for public repos.
 * @returns the issue body text.
 * @throws if the request fails or the response has no body, with the status in
 *   the message so the caller can decide to skip the oracle rather than guess.
 */
export async function fetchIssueText(
  owner: string,
  repo: string,
  issueNumber: number,
  token?: string,
): Promise<string> {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "claimcheck-oracle",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(
      `GitHub issue fetch failed: ${owner}/${repo}#${issueNumber} returned ${response.status} ${response.statusText}; check the link, the repo visibility, or pass a token`,
    );
  }
  const json = (await response.json()) as IssueResponse;
  if (typeof json.body !== "string") {
    throw new Error(
      `GitHub issue ${owner}/${repo}#${issueNumber} has no text body; the oracle has nothing to extract`,
    );
  }
  return json.body;
}

/**
 * Fetch a linked issue and wrap its body as oracle input. Convenience for the
 * live runner: it returns the `issue-text` repro input the deterministic core
 * extracts from.
 *
 * @param owner - repository owner.
 * @param repo - repository name.
 * @param issueNumber - the linked issue number.
 * @param token - optional GitHub token.
 * @returns the issue text wrapped as a repro input.
 */
export async function fetchIssueReproInput(
  owner: string,
  repo: string,
  issueNumber: number,
  token?: string,
): Promise<ReproInput> {
  const text = await fetchIssueText(owner, repo, issueNumber, token);
  return { kind: "issue-text", text };
}
