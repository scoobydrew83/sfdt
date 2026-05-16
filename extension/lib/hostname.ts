const KNOWN_MIDDLE_SEGMENTS = ['sandbox', 'develop', 'scratch', 'trailblaze'] as const;
function orgIdentifier(hostname: string): string {
  const first = hostname.split('.')[0];
  return first ?? hostname;
}
function middleSegmentOf(hostname: string): string | null {
  for (const segment of KNOWN_MIDDLE_SEGMENTS) {
    if (hostname.includes(`.${segment}.`)) return segment;
  }
  return null;
}
export function setupHostname(hostname: string): string {
  if (hostname.includes('.salesforce-setup.com')) return hostname;
  return `${orgIdentifier(hostname)}.my.salesforce-setup.com`;
}
export function lightningHostname(hostname: string): string {
  if (hostname.includes('.lightning.force.com')) return hostname;
  const middle = middleSegmentOf(hostname);
  return middle === null
    ? `${orgIdentifier(hostname)}.lightning.force.com`
    : `${orgIdentifier(hostname)}.${middle}.lightning.force.com`;
}
export function mySalesforceHostname(hostname: string): string | null {
  if (hostname.includes('.my.salesforce.com')) return hostname;
  if (
    hostname.includes('.lightning.force.com') ||
    hostname.includes('.salesforce-setup.com')
  ) {
    const middle = middleSegmentOf(hostname);
    return middle === null
      ? `${orgIdentifier(hostname)}.my.salesforce.com`
      : `${orgIdentifier(hostname)}.${middle}.my.salesforce.com`;
  }
  return null;
}
