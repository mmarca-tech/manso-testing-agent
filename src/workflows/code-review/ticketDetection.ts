export function detectJiraIssueKey(values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const key = detectJiraIssueKeyInText(value);
    if (key) {
      return key;
    }
  }

  return undefined;
}

export function detectJiraIssueKeyInText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const match = /(?:^|[^A-Z0-9])([A-Z][A-Z0-9]+-\d+)(?![A-Z0-9])/i.exec(value);
  return match?.[1]?.toUpperCase();
}
