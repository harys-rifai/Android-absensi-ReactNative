const EARTH_RADIUS_METERS = 6371000;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export const haversineDistanceMeters = (
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number
): number => {
  const latDiff = toRadians(latitudeB - latitudeA);
  const lonDiff = toRadians(longitudeB - longitudeA);

  const latARad = toRadians(latitudeA);
  const latBRad = toRadians(latitudeB);

  const a =
    Math.sin(latDiff / 2) ** 2 +
    Math.cos(latARad) * Math.cos(latBRad) * Math.sin(lonDiff / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
};
