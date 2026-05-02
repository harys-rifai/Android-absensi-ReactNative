import { Site } from "../types/attendance";

// Fallback sites (used if database is unreachable)
const FALLBACK_SITES: Site[] = [
  {
    id: 'jkt-hq',
    name_site: "Jakarta HQ",
    latitude: -6.2001,
    longitude: 106.8167,
    radiusMeters: 150,
    active: true,
    flag: 'active',
    remark: 'Headquarters Jakarta'
  },
  {
    id: 'bdg-plant',
    name_site: "Bandung Plant",
    latitude: -6.9147,
    longitude: 107.6098,
    radiusMeters: 200,
    active: true,
    flag: 'active',
    remark: 'Distribution Center 1 Bandung'
  },
  {
    id: 'sby-field',
    name_site: "Surabaya Field Office",
    latitude: -7.2575,
    longitude: 112.7521,
    radiusMeters: 200,
    active: true,
    flag: 'active',
    remark: 'Distribution Center 2 Surabaya'
  },
];

// Function to get sites (from DB if online, fallback if offline)
export const getProjectSites = async (): Promise<Site[]> => {
  try {
    // Try to fetch from API
    const response = await fetch(`${process.env.API_BASE_URL || 'http://localhost:4000'}/sites`);
    if (response.ok) {
      const sites = await response.json();
      return sites;
    }
  } catch (error) {
    console.log('Failed to fetch sites from API, using fallback');
  }
  return FALLBACK_SITES;
};

// For backward compatibility (synchronous access)
export const PROJECT_SITES: Site[] = FALLBACK_SITES;
