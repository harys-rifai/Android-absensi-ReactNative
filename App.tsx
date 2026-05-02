import React, { useState, useEffect, useCallback, useMemo } from "react";
import { StatusBar } from "expo-status-bar";
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Alert,
  Platform,
  SafeAreaView,
  TextInput,
  FlatList,
  Modal,
  Image,
} from "react-native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { NavigationContainer } from "@react-navigation/native";
import { BarCodeScanner } from "expo-barcode-scanner";
import * as Location from "expo-location";
import * as SQLite from "expo-sqlite";
import * as ImagePicker from "expo-image-picker";
import { Ionicons } from "@expo/vector-icons";

import {
  loginUser,
  fetchAttendanceRecords,
  fetchNews,
  syncAttendanceRecords,
  setApiBaseUrl,
  getApiBaseUrl,
} from "./src/services/attendanceApi";

import { AttendanceRecord, EngineerUser, Site } from "./src/types/attendance";
import { haversineDistanceMeters } from "./src/utils/geofence";
import { PROJECT_SITES, getProjectSites } from "./src/constants/sites";
import {
  cacheSignedInUser,
  getCachedUser,
  getLocalAttendanceForUser,
  getLocalNews,
  getServerConfig,
  getUnsyncedAttendance,
  initializeLocalDb,
  insertSyncLog,
  markAttendanceSynced,
  NewsItem,
  saveCheckInLocal,
  saveCheckOutLocal,
  saveNewsLocalBatch,
  saveServerConfig,
  getLocalUser,
} from "./src/services/localDb";

// Cleanup old localStorage data on web platform
if (typeof window !== "undefined" && typeof localStorage !== "undefined") {
  try {
    const attendance = JSON.parse(localStorage.getItem("attendance") || "[]");
    if (attendance.length > 0) {
      // Keep only records that have proper structure and deduplicate by date
      const seen = new Set();
      const cleaned: any[] = [];
      attendance.forEach((record: any) => {
        if (!record.check_in) return;
        const date = record.check_in.split("T")[0];
        const key = `${record.employee_id}-${date}`;
        if (!seen.has(key)) {
          seen.add(key);
          cleaned.push(record);
        }
      });
      localStorage.setItem("attendance", JSON.stringify(cleaned));
      console.log(
        `Cleaned localStorage: ${attendance.length} → ${cleaned.length} records`,
      );
    }
  } catch (e) {
    console.error("Cleanup error:", e);
  }
}

const Tab = createBottomTabNavigator();

// === Timezone Utilities (Jakarta/Indonesia UTC+7) ===
const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000; // UTC+7 in milliseconds

const toJakartaTime = (date: Date): Date => {
  // Add UTC+7 offset to get Jakarta time
  return new Date(date.getTime() + JAKARTA_OFFSET_MS);
};

const getJakartaDateString = (date: Date): string => {
  // Simpler approach: just use the date parts directly with UTC+7 adjustment
  const jakartaTime = new Date(date.getTime() + JAKARTA_OFFSET_MS);
  return `${jakartaTime.getUTCFullYear()}-${String(jakartaTime.getUTCMonth() + 1).padStart(2, "0")}-${String(jakartaTime.getUTCDate()).padStart(2, "0")}`;
};

// Helper to get date string from ISO string (handles timezone properly)
const getDateStringFromISO = (isoString: string): string => {
  const d = new Date(isoString);
  // Adjust to Jakarta time (UTC+7)
  const jakarta = new Date(d.getTime() + JAKARTA_OFFSET_MS);
  return `${jakarta.getUTCFullYear()}-${String(jakarta.getUTCMonth() + 1).padStart(2, "0")}-${String(jakarta.getUTCDate()).padStart(2, "0")}`;
};

const isSameDayJakarta = (d1: Date, d2: Date) => {
  const j1 = toJakartaTime(d1);
  const j2 = toJakartaTime(d2);
  return (
    j1.getFullYear() === j2.getFullYear() &&
    j1.getMonth() === j2.getMonth() &&
    j1.getDate() === j2.getDate()
  );
};

const isLate = (checkInStr: string) => {
  try {
    const d = new Date(checkInStr);
    const jakarta = toJakartaTime(d);
    const hours = jakarta.getHours();
    const minutes = jakarta.getMinutes();
    return hours > 9 || (hours === 9 && minutes > 0);
  } catch {
    return false;
  }
};

// Indonesian Holidays 2026 (sample - add more as needed)
const HOLIDAYS_2026 = [
  "2026-01-01", // New Year
  "2026-01-29", // Chinese New Year
  "2026-03-29", // Nyepi
  "2026-04-03", // Good Friday
  "2026-05-01", // Labor Day
  "2026-05-13", // Ascension of Jesus
  "2026-05-29", // Waisak
  "2026-06-01", // Pancasila Day
  "2026-06-06", // Eid al-Fitr (estimated)
  "2026-06-07", // Eid al-Fitr (estimated)
  "2026-08-17", // Independence Day
  "2026-09-12", // Eid al-Adha (estimated)
  "2026-10-01", // Islamic New Year (estimated)
  "2026-12-25", // Christmas
];

const formatTime = (iso: string): string => {
  try {
    const d = new Date(iso);
    const jakarta = toJakartaTime(d);
    return jakarta.toLocaleString("id-ID", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
};

function AbsensiScreen({
  user,
  onLogout,
}: {
  user: EngineerUser;
  onLogout: () => void;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastMessage, setLastMessage] = useState("No attendance activity yet.");
  const [isSyncing, setIsSyncing] = useState(false);
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [isLoadingRecords, setIsLoadingRecords] = useState(false);
  const [userSite, setUserSite] = useState<Site | null>(null);
  const [summary, setSummary] = useState({
    totalAttendance: 0,
    lateCount: 0,
    leaveCount: 0,
    approvedLeave: 0,
    pendingLeave: 0,
  });

  const selectedSite: Site = userSite || (PROJECT_SITES && PROJECT_SITES[0]) || { id: 1, name_site: "Jakarta HQ", latitude: -6.2001, longitude: 106.8167, radiusMeters: 150, active: true, flag: 'active', remark: '' };

  useEffect(() => {
    const loadSites = async () => {
      console.log('Loading sites... user.site_id:', user.site_id);
      const sites = await getProjectSites();
      console.log('Sites loaded:', sites.length, sites);
      const site = sites.find((s) => s.id === Number(user.site_id));
      console.log('Found site:', site);
      if (site) setUserSite(site);
    };

    if (user.site_id) {
      void loadSites();
    } else {
      console.log('No site_id, using fallback site');
      setUserSite(PROJECT_SITES[0]);
    }
  }, [user.site_id]);

  const loadAttendance = useCallback(async () => {
    setIsLoadingRecords(true);
    try {
      // Fetch from server first (authoritative source)
      let remoteRecords: AttendanceRecord[] = [];
      try {
        remoteRecords = await fetchAttendanceRecords(user.id, user.role);
        console.log("Fetched from server:", remoteRecords.length, "records");
      } catch (e) {
        console.log("Server fetch failed, using local data:", e);
      }

      // Get local records
      const local = await getLocalAttendanceForUser(user.id);

      // Merge: prioritize server data, fill with local if server fails
      const byDate = new Map<string, AttendanceRecord>();

      // Add remote records (mark as synced)
      for (const r of remoteRecords) {
        if (!r.check_in) continue;
        const date = new Date(r.check_in).toISOString().split("T")[0];
        r.synced = true; // Server data is synced
        byDate.set(date, r);
      }

      // Add local records only if no server record for that date
      for (const r of local) {
        if (!r.check_in) continue;
        const date = new Date(r.check_in).toISOString().split("T")[0];
        if (!byDate.has(date)) {
          byDate.set(date, r);
        }
      }

      const merged = Array.from(byDate.values());
      setRecords(merged);

      // Update last message based on sync status
      if (remoteRecords.length > 0) {
        setLastMessage(
          `Data loaded: ${remoteRecords.length} records from server`,
        );
      } else if (local.length > 0) {
        setLastMessage("Using local data (offline mode)");
      } else {
        setLastMessage("No attendance activity yet.");
      }

      // Fetch summary data
      try {
        const data = await fetch(
          `${getApiBaseUrl()}/dashboard?requesterId=${user.id}&role=${user.role}`,
        ).then((r) => r.json());
        console.log('Dashboard data:', data);
        setSummary({
          totalAttendance: data.summary?.totalAttendance ?? 0,
          lateCount: data.summary?.lateCount ?? 0,
          leaveCount: data.summary?.leaveCount ?? 0,
          approvedLeave: 0,
          pendingLeave: 0,
        });
      } catch {
        console.log("Failed to load summary");
      }
    } catch (error) {
      console.error("Load attendance error:", error);
      setRecords([]);
      setLastMessage("Error loading attendance data.");
    } finally {
      setIsLoadingRecords(false);
    }
  }, [user]);

  const runSync = useCallback(async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    try {
      const unsynced = await getUnsyncedAttendance();
      if (unsynced.length === 0) {
        setLastMessage("No data needs to be synced.");
        setIsSyncing(false);
        return;
      }
      const payload = unsynced.filter((row) => row.employee_id === user.id);
      if (payload.length === 0) {
        setIsSyncing(false);
        return;
      }
      const syncedRefs = await syncAttendanceRecords(payload);
      await markAttendanceSynced(syncedRefs);
      setLastMessage(`Sync successful: ${syncedRefs.length} records sent.`);
      await loadAttendance();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Sync failed to server.";
      setLastMessage("Sync failed. Data remains safe in local storage.");
    }
    setIsSyncing(false);
  }, [isSyncing, user, loadAttendance]);

  useEffect(() => {
    loadAttendance();
    const timer = setInterval(
      () => {
        void runSync();
      },
      15 * 60 * 1000,
    );
    return () => clearInterval(timer);
  }, [loadAttendance, runSync]);

  const submitAttendance = async (mode: "check-in" | "check-out") => {
    setIsSubmitting(true);
    try {
      const permission = await Location.getForegroundPermissionsAsync();
      if (!permission.granted) {
        const requested = await Location.requestForegroundPermissionsAsync();
        if (!requested.granted) {
          Alert.alert(
            "Location Permission Required",
            "Please enable location access in Settings to perform attendance.",
            [{ text: "OK" }],
          );
          setIsSubmitting(false);
          return;
        }
      }

      let latitude: number | null = null;
      let longitude: number | null = null;
      let locAccuracy = 0;

      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("GPS timeout.")), 15000),
        );
        const locationPromise = Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });

        const position = (await Promise.race([
          locationPromise,
          timeoutPromise,
        ])) as Location.LocationObject;
        latitude = position.coords.latitude;
        longitude = position.coords.longitude;
        locAccuracy = position.coords.accuracy || 0;
      } catch (gpsError) {
        console.warn("GPS failed, proceeding without location", gpsError);
      }

      const distance =
        latitude && longitude && selectedSite
          ? haversineDistanceMeters(
              latitude,
              longitude,
              selectedSite.latitude,
              selectedSite.longitude,
            )
          : Infinity;
      console.log('Distance to site:', distance, 'Selected site:', selectedSite?.name_site);
      const locationType =
        distance <= (selectedSite?.radiusMeters || 150) ? "onsite" : "offsite";

      // Get today's date in Jakarta timezone
      const now = new Date();
      const todayJakarta = getJakartaDateString(now);
      console.log('Today (Jakarta):', todayJakarta);
      console.log('Total records:', records.length);
      console.log('Records:', records.map(r => ({id: r.id, check_in: r.check_in, check_out: r.check_out})));

      // Filter today's records using Jakarta date
      const todayRecords = records.filter((r) => {
        if (!r.check_in) return false;
        const checkInDate = getJakartaDateString(new Date(r.check_in));
        return checkInDate === todayJakarta;
      });
      console.log('Today records:', todayRecords.length);

      if (mode === "check-in") {
        // Only block if there's an UNCHECKED-OUT record for today
        const hasOpenCheckin = todayRecords.some((r) => !r.check_out);
        console.log('Has open check-in:', hasOpenCheckin);
        if (hasOpenCheckin) {
          Alert.alert(
            "Already Checked In",
            "You have already checked in today. Please check-out first.",
          );
          setIsSubmitting(false);
          return;
        }
        console.log('Calling saveCheckInLocal...');
        const checkInSuccess = await saveCheckInLocal(
          user.id,
          latitude,
          longitude,
          locationType,
        );
        console.log('saveCheckInLocal result:', checkInSuccess);
        if (!checkInSuccess) {
          Alert.alert(
            "Check-in Failed",
            "You have already checked in today. Only one check-in per day is allowed.",
          );
          setIsSubmitting(false);
          return;
        }
        console.log('Check-in successful!');
        setLastMessage(
          `Check-in successful at ${locationType === "onsite" ? "inside" : "outside"} area`,
        );
      } else {
        const hasOpenCheckin = todayRecords.some((r) => !r.check_out);
        if (!hasOpenCheckin) {
          Alert.alert("No Check-in", "You haven't checked in today.");
          setIsSubmitting(false);
          return;
        }
        const checkOutSuccess = await saveCheckOutLocal(
          user.id,
          latitude,
          longitude,
          locationType,
        );
        if (!checkOutSuccess) {
          Alert.alert(
            "Check-out Failed",
            "You have already checked out today. Only one check-out per day is allowed.",
          );
          setIsSubmitting(false);
          return;
        }
        setLastMessage(
          `Check-out successful at ${locationType === "onsite" ? "inside" : "outside"} area`,
        );
      }

      await loadAttendance();
      await runSync();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      Alert.alert("Error", message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const formatTimeJakarta = (iso: string): string => {
    try {
      const d = new Date(iso);
      const jakarta = toJakartaTime(d);
      return jakarta.toLocaleString("id-ID", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    } catch {
      return iso;
    }
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.screenContainer}
    >
      <Text style={styles.title}>Hello, {user.name}</Text>
      <Text style={styles.subtitle}>
        Role: {user.role}
        {userSite ? ` • ${userSite.name}` : ""}
      </Text>

      {isSubmitting ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator />
          <Text style={styles.loadingText}>Getting GPS location...</Text>
        </View>
      ) : null}
      <Text style={styles.infoText}>{lastMessage}</Text>

      {/* User Summary */}
      <View style={[styles.sectionLabel, { marginTop: 20 }]}>
        <Text style={{ fontSize: 16, fontWeight: "600" }}>Summary</Text>
      </View>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          marginTop: 12,
        }}
      >
        <View style={[styles.statCard, { flex: 1, minWidth: "45%" }]}>
          <Text style={[styles.statNumber, { color: "#34c759" }]}>
            {summary.totalAttendance}
          </Text>
          <Text style={styles.statLabel}>Check-in</Text>
        </View>
        <View style={[styles.statCard, { flex: 1, minWidth: "45%" }]}>
          <Text style={[styles.statNumber, { color: "#007AFF" }]}>
            {records.filter((r) => r.check_in && r.check_out).length}
          </Text>
          <Text style={styles.statLabel}>Check-out</Text>
        </View>
        <View style={[styles.statCard, { flex: 1, minWidth: "45%" }]}>
          <Text style={[styles.statNumber, { color: "#FFD700" }]}>
            {summary.lateCount}
          </Text>
          <Text style={styles.statLabel}>Late</Text>
        </View>
        <View style={[styles.statCard, { flex: 1, minWidth: "45%" }]}>
          <Text style={[styles.statNumber, { color: "#ff9500" }]}>
            {summary.leaveCount}
          </Text>
          <Text style={styles.statLabel}>Cuti</Text>
        </View>
      </View>

      {/* Show recent attendance history */}
      <View style={{ marginTop: 20 }}>
        <Text style={[styles.sectionLabel, { marginTop: 0 }]}>
          Recent History
        </Text>
        {records.length > 0 ? (
          records
            .filter((r) => r.check_in)
            .sort(
              (a, b) =>
                new Date(b.check_in!).getTime() -
                new Date(a.check_in!).getTime(),
            )
            .slice(0, 5)
            .map((item, idx) => (
              <View key={idx} style={styles.recordCard}>
                <View
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <Text style={styles.recordMeta}>
                    {toJakartaTime(new Date(item.check_in!)).toLocaleString(
                      "id-ID",
                      { day: "numeric", month: "short" },
                    )}
                  </Text>
                  <Text
                    style={[
                      styles.recordMeta,
                      item.synced ? styles.okText : styles.warnText,
                    ]}
                  >
                    {item.synced ? "✓ Synced" : "⏳ Pending"}
                  </Text>
                </View>
                <Text style={styles.recordTitle}>
                  {item.employee_name ?? user.name}
                </Text>
                <Text style={styles.recordMeta}>
                  Check-in:{" "}
                  {item.check_in ? formatTimeJakarta(item.check_in) : "-"}
                </Text>
                <Text style={styles.recordMeta}>
                  {item.check_out
                    ? `Check-out: ${formatTimeJakarta(item.check_out)}`
                    : "Not checked out"}
                </Text>
              </View>
            ))
        ) : (
          <Text style={styles.emptyText}>No attendance history</Text>
        )}
      </View>

      <View style={styles.actionRow}>
        <Pressable
          style={[styles.primaryButton, styles.flexButton]}
          disabled={isSubmitting}
          onPress={() => submitAttendance("check-in")}
        >
          <Text style={styles.primaryButtonText}>Check-in</Text>
        </Pressable>
        <Pressable
          style={[styles.secondaryButton, styles.flexButton]}
          disabled={isSubmitting}
          onPress={() => submitAttendance("check-out")}
        >
          <Text style={styles.secondaryButtonText}>Check-out</Text>
        </Pressable>
      </View>

      <View style={styles.actionRow}>
        <Pressable
          style={[styles.secondaryButton, styles.flexButton]}
          disabled={isSyncing}
          onPress={() => {
            void runSync();
          }}
        >
          <Text style={styles.secondaryButtonText}>
            {isSyncing ? "Syncing..." : "Sync Now"}
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

function RiwayatScreen({ user }: { user: EngineerUser }) {
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const loadAttendance = useCallback(async () => {
    setIsLoading(true);
    try {
      const remote = await fetchAttendanceRecords(user.id, user.role);
      setRecords(remote);
    } catch {
      const local = await getLocalAttendanceForUser(user.id);
      setRecords(local);
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  const syncAndReload = useCallback(async () => {
    try {
      const unsynced = await getUnsyncedAttendance();
      if (unsynced.length > 0) {
        const payload = unsynced.filter(
          (row) =>
            row.employee_id === user.id ||
            user.role === "hrd" ||
            user.role === "admin",
        );
        if (payload.length > 0) {
          await syncAttendanceRecords(payload);
          await markAttendanceSynced(
            payload.map((r) => r.client_ref!).filter(Boolean),
          );
        }
      }
      await loadAttendance();
    } catch (error) {
      console.log("Sync failed, using local data");
      await loadAttendance();
    }
  }, [user, loadAttendance]);

  useEffect(() => {
    syncAndReload();
    const timer = setInterval(
      () => {
        void syncAndReload();
      },
      15 * 60 * 1000,
    );
    return () => clearInterval(timer);
  }, [syncAndReload]);

  const formatTime = (iso: string): string => {
    try {
      const d = new Date(iso);
      const jakarta = toJakartaTime(d);
      return jakarta.toLocaleString("id-ID", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    } catch {
      return iso;
    }
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.screenContainer}
    >
      <Text style={styles.title}>Attendance History</Text>

      <View style={styles.actionRow}>
        <Pressable
          style={[styles.secondaryButton, styles.flexButton]}
          disabled={isLoading}
          onPress={() => {
            void syncAndReload();
          }}
        >
          <Text style={styles.secondaryButtonText}>
            {isLoading ? "Syncing..." : "Sync & Refresh"}
          </Text>
        </Pressable>
      </View>

      {isLoading ? (
        <ActivityIndicator />
      ) : (
        <FlatList
          data={records
            .filter((r) => r.check_in)
            .sort(
              (a, b) =>
                new Date(b.check_in!).getTime() -
                new Date(a.check_in!).getTime(),
            )}
          keyExtractor={(item) =>
            item.client_ref || String(item.id ?? Math.random())
          }
          scrollEnabled={false}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No attendance records yet.</Text>
          }
          renderItem={({ item }) => (
            <View style={styles.recordCard}>
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <Text style={styles.recordMeta}>
                  {toJakartaTime(new Date(item.check_in!)).toLocaleString(
                    "id-ID",
                    { day: "numeric", month: "short" },
                  )}
                </Text>
                <Text
                  style={[
                    styles.recordMeta,
                    item.synced ? styles.okText : styles.warnText,
                  ]}
                >
                  {item.synced ? "✓ Synced" : "⏳ Pending"}
                </Text>
              </View>
              <Text style={styles.recordTitle}>
                {item.employee_name ?? user.name}
              </Text>
              <Text style={styles.recordMeta}>
                Check-in: {item.check_in ? formatTime(item.check_in) : "-"}
              </Text>
              <Text style={styles.recordMeta}>
                {item.check_out
                  ? `Check-out: ${formatTime(item.check_out!)}`
                  : "Not checked out yet"}
              </Text>
            </View>
          )}
        />
      )}
    </ScrollView>
  );
}

function BeritaScreen() {
  const [news, setNews] = useState<NewsItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const loadNews = useCallback(async () => {
    setIsLoading(true);
    try {
      const remoteNews = await fetchNews();
      setNews(remoteNews);
      await saveNewsLocalBatch(remoteNews);
    } catch {
      const localNews = await getLocalNews();
      setNews(localNews);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadNews();
    const timer = setInterval(
      () => {
        void loadNews();
      },
      15 * 60 * 1000,
    );
    return () => clearInterval(timer);
  }, [loadNews]);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.screenContainer}
    >
      <Text style={styles.title}>News & Updates</Text>
      {isLoading ? (
        <ActivityIndicator />
      ) : (
        <FlatList
          data={news}
          keyExtractor={(item) => String(item.remote_id || item.id)}
          scrollEnabled={false}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No news available.</Text>
          }
          renderItem={({ item }) => (
            <View style={styles.newsCard}>
              <Text style={styles.newsTitle}>{item.title}</Text>
              <Text style={styles.newsContent}>{item.content}</Text>
              {item.author_name ? (
                <Text style={styles.newsAuthor}>By: {item.author_name}</Text>
              ) : null}
              {item.published_at ? (
                <Text style={styles.newsDate}>
                  {new Date(item.published_at).toLocaleString("en-US", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </Text>
              ) : null}
            </View>
          )}
        />
      )}
      <Pressable
        style={[styles.secondaryButton, { marginTop: 12 }]}
        onPress={() => {
          void loadNews();
        }}
      >
        <Text style={styles.secondaryButtonText}>
          {isLoading ? "Loading..." : "Refresh News"}
        </Text>
      </Pressable>
    </ScrollView>
  );
}

type RequestItem = {
  id: number;
  employee_id: number;
  employee_name?: string;
  type: "leave" | "overtime" | "late" | "off";
  status: string;
  start_date?: string;
  end_date?: string;
  overtime_date?: string;
  hours?: number;
  note?: string;
  manager_approved?: boolean;
  hrd_approved?: boolean;
  manager_remark?: string;
  hrd_remark?: string;
};

function RequestsScreen({ user }: { user: EngineerUser }) {
  const [requests, setRequests] = useState<RequestItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<
    "all" | "leave" | "overtime" | "late" | "off"
  >("all");

  const loadRequests = useCallback(async () => {
    setIsLoading(true);
    try {
      const baseUrl = getApiBaseUrl();
      const [leaveRes, overtimeRes] = await Promise.all([
        fetch(`${baseUrl}/leave?requesterId=${user.id}&role=${user.role}`).then(
          (r) => r.json(),
        ),
        fetch(
          `${baseUrl}/overtime?requesterId=${user.id}&role=${user.role}`,
        ).then((r) => r.json()),
      ]);

      const items: RequestItem[] = [
        ...(leaveRes || []).map((r: any) => ({ ...r, type: "leave" as const })),
        ...(overtimeRes || []).map((r: any) => ({
          ...r,
          type: "overtime" as const,
        })),
      ];

      setRequests(items);
    } catch (error) {
      console.log("Failed to load requests", error);
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadRequests();
    const timer = setInterval(
      () => {
        void loadRequests();
      },
      15 * 60 * 1000,
    );
    return () => clearInterval(timer);
  }, [loadRequests]);

  const filteredRequests =
    activeTab === "all"
      ? requests
      : requests.filter((r) => r.type === activeTab);

  const getStatusColor = (status: string) => {
    if (status.includes("approved")) return "#34c759";
    if (status.includes("rejected")) return "#ff3b30";
    if (status.includes("pending")) return "#ffcc00";
    return "#8e8e93";
  };

  const getStatusText = (item: RequestItem) => {
    if (item.type === "leave") {
      if (item.status === "approved") return "✓ Approved";
      if (item.status === "pending_hrd") return "⏳ Waiting HRD";
      if (item.status === "pending_manager") return "⏳ Waiting Manager";
      if (item.status === "rejected") return "✗ Rejected";
    }
    return item.status;
  };

  const [modalVisible, setModalVisible] = useState(false);
  const [requestType, setRequestType] = useState<
    "leave" | "overtime" | "late" | "off"
  >("leave");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [note, setNote] = useState("");
  const [hours, setHours] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submitRequest = async () => {
    if (!startDate || !note) {
      Alert.alert("Error", "Please fill required fields (Date & Note)");
      return;
    }
    setIsSubmitting(true);
    try {
      const endpoint =
        requestType === "overtime" ? "/overtime/request" : "/leave/request";
      const payload: any = {
        requesterId: user.id,
        note,
        status: "pending_manager",
      };

      if (requestType === "overtime") {
        payload.overtimeDate = startDate;
        payload.hours = parseFloat(hours) || 1;
      } else {
        payload.startDate = startDate;
        payload.endDate = endDate || startDate;
        payload.leaveType = requestType;
      }

      const response = await fetch(`${getApiBaseUrl()}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) throw new Error("Submission failed");

      setModalVisible(false);
      setNote("");
      setStartDate("");
      setEndDate("");
      setHours("");
      Alert.alert("Success", "Request submitted successfully");
      void loadRequests();
    } catch (e) {
      Alert.alert("Error", "Failed to submit request");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.screenContainer}
    >
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <View>
          <Text style={[styles.title, { textAlign: "left" }]}>Requests</Text>
          <Text style={[styles.subtitle, { textAlign: "left" }]}>
            Manage your requests
          </Text>
        </View>
        <Pressable
          style={[
            styles.primaryButton,
            { paddingVertical: 8, paddingHorizontal: 12 },
          ]}
          onPress={() => setModalVisible(true)}
        >
          <Text style={[styles.primaryButtonText, { fontSize: 13 }]}>
            + New Request
          </Text>
        </Pressable>
      </View>

      <View
        style={{
          flexDirection: "row",
          gap: 6,
          marginTop: 12,
          marginBottom: 12,
        }}
      >
        {(["all", "leave", "overtime", "late", "off"] as const).map((tab) => (
          <Pressable
            key={tab}
            style={[
              styles.secondaryButton,
              { flex: 1, paddingVertical: 8 },
              activeTab === tab && { backgroundColor: "#007AFF" },
            ]}
            onPress={() => setActiveTab(tab)}
          >
            <Text
              style={[
                styles.secondaryButtonText,
                activeTab === tab && { color: "#fff" },
                { fontSize: 11 },
              ]}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </Text>
          </Pressable>
        ))}
      </View>

      <Pressable
        style={[styles.secondaryButton, { marginBottom: 12 }]}
        onPress={() => {
          void loadRequests();
        }}
      >
        <Text style={styles.secondaryButtonText}>
          {isLoading ? "Loading..." : "Refresh"}
        </Text>
      </Pressable>

      {isLoading ? (
        <ActivityIndicator />
      ) : filteredRequests.length > 0 ? (
        filteredRequests.map((item, idx) => (
          <View key={idx} style={styles.recordCard}>
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <Text style={styles.recordTitle}>
                {item.employee_name ?? "Employee"} -{" "}
                {item.type.charAt(0).toUpperCase() + item.type.slice(1)}
              </Text>
              <View
                style={{
                  backgroundColor: getStatusColor(item.status),
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 6,
                }}
              >
                <Text
                  style={{ color: "#fff", fontSize: 10, fontWeight: "600" }}
                >
                  {getStatusText(item)}
                </Text>
              </View>
            </View>
            {item.type === "leave" && (
              <>
                <Text style={styles.recordMeta}>
                  Period: {item.start_date} s/d {item.end_date}
                </Text>
                {item.manager_remark && (
                  <Text style={styles.recordMeta}>
                    Manager Remark: {item.manager_remark}
                  </Text>
                )}
                {item.hrd_remark && (
                  <Text style={styles.recordMeta}>
                    HRD Remark: {item.hrd_remark}
                  </Text>
                )}
              </>
            )}
            {item.type === "overtime" && (
              <Text style={styles.recordMeta}>
                {item.overtime_date} - {item.hours} hours
              </Text>
            )}
            {item.note && (
              <Text style={styles.recordMeta}>Note: {item.note}</Text>
            )}
          </View>
        ))
      ) : (
        <Text style={styles.emptyText}>No requests found</Text>
      )}

      <Modal visible={modalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>New Request</Text>

            <View
              style={{
                flexDirection: "row",
                gap: 6,
                marginBottom: 12,
                flexWrap: "wrap",
                justifyContent: "center",
              }}
            >
              {(["leave", "overtime", "late", "off"] as const).map((type) => (
                <Pressable
                  key={type}
                  style={[
                    styles.secondaryButton,
                    { paddingVertical: 6, paddingHorizontal: 10 },
                    requestType === type && { backgroundColor: "#007AFF" },
                  ]}
                  onPress={() => setRequestType(type)}
                >
                  <Text
                    style={[
                      styles.secondaryButtonText,
                      { fontSize: 11 },
                      requestType === type && { color: "#fff" },
                    ]}
                  >
                    {type.charAt(0).toUpperCase() + type.slice(1)}
                  </Text>
                </Pressable>
              ))}
            </View>

            <TextInput
              style={[
                styles.input,
                { marginBottom: 10, borderWidth: 1, borderColor: "#ccc" },
              ]}
              placeholder={
                requestType === "overtime"
                  ? "Overtime Date (YYYY-MM-DD)"
                  : "Start Date (YYYY-MM-DD)"
              }
              value={startDate}
              onChangeText={setStartDate}
            />

            {requestType !== "overtime" && (
              <TextInput
                style={[
                  styles.input,
                  { marginBottom: 10, borderWidth: 1, borderColor: "#ccc" },
                ]}
                placeholder="End Date (YYYY-MM-DD) [Optional]"
                value={endDate}
                onChangeText={setEndDate}
              />
            )}

            {requestType === "overtime" && (
              <TextInput
                style={[
                  styles.input,
                  { marginBottom: 10, borderWidth: 1, borderColor: "#ccc" },
                ]}
                placeholder="Hours (e.g. 2.5)"
                value={hours}
                onChangeText={setHours}
                keyboardType="numeric"
              />
            )}

            <TextInput
              style={[
                styles.input,
                {
                  marginBottom: 16,
                  borderWidth: 1,
                  borderColor: "#ccc",
                  height: 80,
                },
              ]}
              placeholder="Reason / Note"
              value={note}
              onChangeText={setNote}
              multiline
            />

            <View style={{ flexDirection: "row", gap: 8 }}>
              <Pressable
                style={[styles.secondaryButton, { flex: 1 }]}
                onPress={() => setModalVisible(false)}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.primaryButton, { flex: 1 }]}
                onPress={() => {
                  void submitRequest();
                }}
                disabled={isSubmitting}
              >
                <Text style={styles.primaryButtonText}>
                  {isSubmitting ? "Submitting..." : "Submit"}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function ApprovalsScreen({ user }: { user: EngineerUser }) {
  const [pendingRequests, setPendingRequests] = useState<RequestItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [remark, setRemark] = useState("");
  const [selectedRequest, setSelectedRequest] = useState<RequestItem | null>(
    null,
  );

  const loadPending = useCallback(async () => {
    setIsLoading(true);
    try {
      const [leaveRes, overtimeRes] = await Promise.all([
        fetch(`/leave?role=${user.role}`).then((r) =>
          r.json(),
        ),
        fetch(`/overtime?role=${user.role}`).then((r) =>
          r.json(),
        ),
      ]);

      const items: RequestItem[] = [
        ...(leaveRes || [])
          .filter((r: any) => {
            if (user.role === "manager_line") return r.status === "pending_manager";
            if (user.role === "hrd") return r.status === "pending_hrd";
            return false;
          })
          .map((r: any) => ({ ...r, type: "leave" as const })),
        ...(overtimeRes || [])
          .filter((r: any) => {
            if (user.role === "manager_line") return r.status === "pending_manager";
            if (user.role === "hrd") return r.status === "pending_hrd";
            return false;
          })
          .map((r: any) => ({ ...r, type: "overtime" as const })),
      ];

      setPendingRequests(items);
    } catch (error) {
      console.log("Failed to load pending requests", error);
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadPending();
    const timer = setInterval(
      () => {
        void loadPending();
      },
      15 * 60 * 1000,
    );
    return () => clearInterval(timer);
  }, [loadPending]);

  const handleApproval = async (
    item: RequestItem,
    action: "approve" | "reject",
  ) => {
    try {
      const endpoint =
        item.type === "leave"
          ? user.role === "manager_line"
            ? "/leave/approve-manager"
            : "/leave/approve-hrd"
          : user.role === "manager_line"
            ? "/overtime/approve-manager"
            : "/overtime/approve-hrd";

      const url = `${endpoint}/${item.id}`;
      const body =
        action === "approve"
          ? { approverId: user.id }
          : { approverId: user.id, remark: remark || "Rejected" };

      const result = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (result.ok) {
        Alert.alert("Success", `Request ${action}d successfully`);
        setSelectedRequest(null);
        setRemark("");
        await loadPending();
      } else {
        const error = await result.json();
        Alert.alert("Error", error.error || `Failed to ${action} request`);
      }
    } catch (error) {
      Alert.alert("Error", `Failed to ${action} request`);
    }
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.screenContainer}
    >
      <Text style={styles.title}>Approvals</Text>
      <Text style={styles.subtitle}>
        {user.role === "manager_line"
          ? "Pending Manager Approval"
          : "Pending HRD Approval"}
      </Text>

      <Pressable
        style={[styles.secondaryButton, { marginBottom: 12 }]}
        onPress={() => {
          void loadPending();
        }}
      >
        <Text style={styles.secondaryButtonText}>
          {isLoading ? "Loading..." : "Refresh"}
        </Text>
      </Pressable>

      {isLoading ? (
        <ActivityIndicator />
      ) : pendingRequests.length > 0 ? (
        pendingRequests.map((item, idx) => (
          <View key={idx} style={styles.recordCard}>
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <Text style={styles.recordTitle}>
                {item.employee_name || "Employee"} -{" "}
                {item.type.charAt(0).toUpperCase() + item.type.slice(1)}
              </Text>
              <View
                style={{
                  backgroundColor:
                    item.type === "leave" ? "#ffcc00" : "#5856d6",
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 6,
                }}
              >
                <Text
                  style={{ color: "#fff", fontSize: 10, fontWeight: "600" }}
                >
                  {item.type === "leave" ? "Leave" : "Overtime"}
                </Text>
              </View>
            </View>

            {item.type === "leave" && (
              <Text style={styles.recordMeta}>
                Period: {item.start_date} s/d {item.end_date}
              </Text>
            )}
            {item.type === "overtime" && (
              <Text style={styles.recordMeta}>
                {item.overtime_date} - {item.hours} hours
              </Text>
            )}
            {item.note && (
              <Text style={styles.recordMeta}>Note: {item.note}</Text>
            )}

            {selectedRequest?.id === item.id ? (
              <View style={{ marginTop: 12 }}>
                <TextInput
                  style={[styles.input, { marginBottom: 8 }]}
                  placeholder="Add remark (optional)"
                  value={remark}
                  onChangeText={setRemark}
                  multiline
                />
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Pressable
                    style={[styles.primaryButton, { flex: 1 }]}
                    onPress={() => handleApproval(item, "approve")}
                  >
                    <Text style={styles.primaryButtonText}>Approve</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.destructiveButton, { flex: 1 }]}
                    onPress={() => handleApproval(item, "reject")}
                  >
                    <Text style={styles.destructiveButtonText}>Reject</Text>
                  </Pressable>
                </View>
                <Pressable
                  style={{ marginTop: 8 }}
                  onPress={() => {
                    setSelectedRequest(null);
                    setRemark("");
                  }}
                >
                  <Text
                    style={{
                      color: "#007AFF",
                      fontSize: 12,
                      textAlign: "center",
                    }}
                  >
                    Cancel
                  </Text>
                </Pressable>
              </View>
            ) : (
              <Pressable
                style={[styles.secondaryButton, { marginTop: 8 }]}
                onPress={() => setSelectedRequest(item)}
              >
                <Text style={styles.secondaryButtonText}>Review & Action</Text>
              </Pressable>
            )}
          </View>
        ))
      ) : (
        <Text style={styles.emptyText}>No pending requests</Text>
      )}
    </ScrollView>
  );
}

function DashboardScreen({ user }: { user: EngineerUser }) {
  const [stats, setStats] = useState({
    totalUsers: 0,
    totalAttendance: 0,
    lateCount: 0,
    leaveCount: 0,
    overtimeCount: 0,
    pendingLeave: 0,
  });
  const [isLoading, setIsLoading] = useState(false);

  const loadStats = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await fetch(
        `/dashboard?requesterId=${user.id}&role=${user.role}`,
      ).then((r) => r.json());
      setStats({
        totalUsers: 0,
        totalAttendance: data.summary?.totalAttendance ?? 0,
        lateCount: data.summary?.lateCount ?? 0,
        leaveCount: data.summary?.leaveCount ?? 0,
        overtimeCount: data.summary?.overtimeCount ?? 0,
        pendingLeave: 0,
      });
    } catch {
      console.log("Failed to load dashboard");
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadStats();
    const timer = setInterval(
      () => {
        void loadStats();
      },
      15 * 60 * 1000,
    );
    return () => clearInterval(timer);
  }, [loadStats]);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.screenContainer}
    >
      <Text style={styles.title}>Dashboard</Text>
      <Text style={[styles.subtitle, { marginBottom: 16 }]}>
        Summary for {user.name}
      </Text>

      {isLoading ? <ActivityIndicator /> : null}

      <View style={styles.statsContainer}>
        <View style={styles.statCard}>
          <Text style={styles.statNumber}>{stats.totalAttendance}</Text>
          <Text style={styles.statLabel}>Total Attendance</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={[styles.statNumber, { color: "#ff9500" }]}>
            {stats.lateCount}
          </Text>
          <Text style={styles.statLabel}>Late</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={[styles.statNumber, { color: "#34c759" }]}>
            {stats.leaveCount}
          </Text>
          <Text style={styles.statLabel}>Cuti</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={[styles.statNumber, { color: "#5856d6" }]}>
            {stats.overtimeCount}
          </Text>
          <Text style={styles.statLabel}>Overtime</Text>
        </View>
      </View>

      <Pressable
        style={[styles.secondaryButton, { marginTop: 16 }]}
        onPress={() => {
          void loadStats();
        }}
      >
        <Text style={styles.secondaryButtonText}>
          {isLoading ? "Loading..." : "Refresh Dashboard"}
        </Text>
      </Pressable>
    </ScrollView>
  );
}

function PengaturanScreen({
  user,
  onLogout,
  onProfileUpdate,
}: {
  user: EngineerUser;
  onLogout: () => void;
  onProfileUpdate: (updatedUser: EngineerUser) => void;
}) {
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [serverUrlInput, setServerUrlInput] = useState("");
  const [editMode, setEditMode] = useState(false);
  const [editName, setEditName] = useState(user.name);
  const [editPhone, setEditPhone] = useState(user.phone || "");
  const [editFoto, setEditFoto] = useState(user.foto || "");
  const [saving, setSaving] = useState(false);

  const loadCurrentUrl = async () => {
    const url = await getServerConfig("api_base_url");
    setServerUrlInput(url || getApiBaseUrl());
  };

  useEffect(() => {
    if (settingsVisible) {
      loadCurrentUrl();
    }
  }, [settingsVisible]);

  const pickImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.5,
      base64: true,
    });

    if (!result.canceled && result.assets[0].base64) {
      setEditFoto(`data:image/jpeg;base64,${result.assets[0].base64}`);
    }
  };

  const saveProfile = async () => {
    if (!editName.trim()) {
      Alert.alert("Error", "Name cannot be empty");
      return;
    }

    setSaving(true);
    try {
      const updatedUser = {
        ...user,
        name: editName.trim(),
        phone: editPhone.trim(),
        foto: editFoto,
      };

      // Save to local storage first (offline-first)
      await cacheSignedInUser(updatedUser);

      // Try to save to server (PostgreSQL)
      try {
        const apiUrl = getApiBaseUrl();
        const response = await fetch(`${apiUrl}/api/update-profile`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: user.email,
            name: editName.trim(),
            phone: editPhone.trim(),
            foto: editFoto,
          }),
        });

        if (response.ok) {
          const data = await response.json();
          console.log("✓ Profile saved to PostgreSQL:", data.message);
          // Update with server response (ensures data is in PostgreSQL)
          if (data.user) {
            updatedUser.name = data.user.name || updatedUser.name;
            updatedUser.phone = data.user.phone || updatedUser.phone;
            updatedUser.foto = data.user.foto || updatedUser.foto;
          }
        } else {
          const error = await response.json();
          console.error("Server update failed:", error.error);
          Alert.alert("Warning", "Saved locally. Will sync to server when online.");
        }
      } catch (error) {
        console.log("Server unreachable, saved locally");
        Alert.alert("Offline Mode", "Profile saved locally. Will sync when online.");
      }

      // Update parent state with new user data
      onProfileUpdate(updatedUser);

      setEditMode(false);
      Alert.alert("Success", "Profile updated successfully");
    } catch (error) {
      Alert.alert("Error", "Failed to update profile");
    } finally {
      setSaving(false);
    }
  };

  const saveServerUrl = async () => {
    if (!serverUrlInput.trim()) {
      Alert.alert("Error", "Server URL cannot be empty");
      return;
    }
    try {
      await saveServerConfig("api_base_url", serverUrlInput.trim());
      setApiBaseUrl(serverUrlInput.trim());
      setSettingsVisible(false);
      Alert.alert(
        "Success",
        "Server URL saved. Restart the app to apply changes.",
      );
    } catch (error) {
      Alert.alert("Error", "Failed to save server URL");
    }
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.screenContainer}
    >
      <Text style={styles.title}>Settings</Text>

      <View style={styles.profileCard}>
        <Pressable
          style={styles.profileImageContainer}
          onPress={editMode ? pickImage : undefined}
        >
          {editFoto || user.foto ? (
            <Image
              source={{ uri: editMode ? editFoto : user.foto }}
              style={styles.profileImage}
            />
          ) : (
            <View style={styles.profileImagePlaceholder}>
              <Text style={styles.profileImagePlaceholderText}>
                {(editMode ? editName : user.name).charAt(0).toUpperCase()}
              </Text>
            </View>
          )}
          {editMode && (
            <View style={styles.editPhotoBadge}>
              <Ionicons name="camera" size={16} color="#fff" />
            </View>
          )}
        </Pressable>

        {editMode ? (
          <View style={styles.editForm}>
            <TextInput
              style={styles.editInput}
              value={editName}
              onChangeText={setEditName}
              placeholder="Full Name"
            />
            <TextInput
              style={styles.editInput}
              value={editPhone}
              onChangeText={setEditPhone}
              placeholder="Phone Number"
              keyboardType="phone-pad"
            />
            <View style={styles.editButtonRow}>
              <Pressable
                style={[styles.secondaryButton, { flex: 1 }]}
                onPress={() => {
                  setEditMode(false);
                  setEditName(user.name);
                  setEditPhone(user.phone || "");
                  setEditFoto(user.foto || "");
                }}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.primaryButton, { flex: 1 }]}
                onPress={saveProfile}
                disabled={saving}
              >
                <Text style={styles.primaryButtonText}>
                  {saving ? "Saving..." : "Save"}
                </Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.profileInfo}>
            <Text style={styles.profileName}>{user.name}</Text>
            <Text style={styles.profileJabatan}>{user.jabatan || "Employee"}</Text>
            <Text style={styles.profileDetail}>📧 {user.email}</Text>
            <Text style={styles.profileDetail}>📱 {user.phone || "No phone"}</Text>
            <Pressable
              style={[styles.secondaryButton, { marginTop: 12 }]}
              onPress={() => {
                setEditName(user.name);
                setEditPhone(user.phone || "");
                setEditFoto(user.foto || "");
                setEditMode(true);
              }}
            >
              <Text style={styles.secondaryButtonText}>Edit Profile</Text>
            </Pressable>
          </View>
        )}
      </View>

      <Pressable
        style={[styles.secondaryButton, { marginTop: 20 }]}
        onPress={() => setSettingsVisible(true)}
      >
        <Text style={styles.secondaryButtonText}>Server Settings</Text>
      </Pressable>

      <Pressable
        style={[styles.secondaryButton, { marginTop: 12 }]}
        onPress={onLogout}
      >
        <Text style={[styles.secondaryButtonText, { color: "#dc2626" }]}>
          Logout
        </Text>
      </Pressable>

      <Modal visible={settingsVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Server Settings</Text>
            <Text style={styles.modalSubtitle}>
              Enter API Server URL (e.g.: http://192.168.1.21:4000)
            </Text>
            <TextInput
              style={styles.input}
              placeholder="http://IP-ADDRESS:4000"
              value={serverUrlInput}
              onChangeText={setServerUrlInput}
              autoCapitalize="none"
              keyboardType="url"
            />
            <Text style={styles.modalHint}>
              • Android Emulator: http://10.0.2.2:4000{"\n"}• USB Debugging:
              http://192.168.1.21:4000{"\n"}• Web: http://localhost:4000
            </Text>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
              <Pressable
                style={[styles.secondaryButton, { flex: 1 }]}
                onPress={() => setServerUrlInput("http://10.0.2.2:4000")}
              >
                <Text style={styles.secondaryButtonText}>Emulator</Text>
              </Pressable>
              <Pressable
                style={[styles.secondaryButton, { flex: 1 }]}
                onPress={() => setServerUrlInput("http://192.168.1.21:4000")}
              >
                <Text style={styles.secondaryButtonText}>USB</Text>
              </Pressable>
              <Pressable
                style={[styles.secondaryButton, { flex: 1 }]}
                onPress={() => setServerUrlInput("http://localhost:4000")}
              >
                <Text style={styles.secondaryButtonText}>Web</Text>
              </Pressable>
            </View>
            <View style={styles.modalButtonRow}>
              <Pressable
                style={[styles.secondaryButton, styles.flexButton]}
                onPress={() => setSettingsVisible(false)}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.primaryButton, styles.flexButton]}
                onPress={saveServerUrl}
              >
                <Text style={styles.primaryButtonText}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

export default function App() {
  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [user, setUser] = useState<EngineerUser | null>(null);
  const [isBooting, setIsBooting] = useState(true);
  const [ipModalVisible, setIpModalVisible] = useState(false);
  const [tempIp, setTempIp] = useState("");

  const handleLogin = async () => {
    const email = emailInput.trim().toLowerCase();
    const password = passwordInput.trim();
    if (!email || !password) {
      Alert.alert("Incomplete Data", "Please fill in email and password.");
      return;
    }
    try {
      // Try server first
      const signedUser = await loginUser({ email, password });

      // Load local user to check for local changes
      const localUser = await getLocalUser(email);

      // Merge: prefer local changes (name, phone, foto) if they exist
      const mergedUser = localUser ? {
        ...signedUser,
        // Keep local changes if they differ from server (likely edited locally)
        name: localUser.name !== signedUser.name ? localUser.name : signedUser.name,
        phone: localUser.phone || signedUser.phone,
        foto: localUser.foto || signedUser.foto,
      } : signedUser;

      setUser(mergedUser);
      await cacheSignedInUser(mergedUser);
    } catch (error) {
      // If server fails, try local login
      try {
        const localUser = await getLocalUser(email);
        if (localUser) {
          setUser(localUser);
          Alert.alert(
            "Offline Mode",
            "Logged in from local storage. Data will sync when online.",
          );
        } else {
          const message =
            error instanceof Error
              ? error.message
              : "Login failed. Check email/password or server connection.";
          Alert.alert("Login Failed", message);
        }
      } catch (localError) {
        const localMessage =
          localError instanceof Error
            ? localError.message
            : "Local login failed.";
        const serverMessage =
          error instanceof Error ? error.message : "Server unreachable.";
        Alert.alert("Login Failed", `${serverMessage}\n\n${localMessage}`);
      }
    }
  };

  const handleLogout = async () => {
    setUser(null);
    setEmailInput("");
    setPasswordInput("");
    // Note: We don't clear cached user data on logout
    // This preserves local changes (profile edits) for next login
    // The cache will be overwritten on next successful login
  };

  useEffect(() => {
    const boot = async () => {
      try {
        await initializeLocalDb();

        // Restore cached user from SQLite (native) or localStorage (web)
        const cachedUser = await getCachedUser();
        if (cachedUser) {
          setUser(cachedUser);
        }

        const localUrl = await getServerConfig("api_base_url");
        // Set default to localhost since Android USB debugging uses adb reverse tcp:4000
        if (localUrl) {
          setApiBaseUrl(localUrl);
        } else {
          setApiBaseUrl("http://localhost:4000");
        }
      } catch (err) {
        console.error("Boot error:", err);
        setApiBaseUrl("http://localhost:4000");
      } finally {
        setIsBooting(false);
      }
    };
    void boot();
  }, []);

  if (isBooting) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.loginContainer}>
          <ActivityIndicator />
          <Text style={styles.subtitle}>Preparing local database...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!user) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        <View style={styles.topNav}>
          <View style={styles.topNavLine} />
        </View>
        <View style={styles.loginContainer}>
          <Text style={styles.title}>Hybrid Attendance</Text>
          <Text style={styles.subtitle}>
            Login from Postgres, user saved locally.
          </Text>
          <TextInput
            style={styles.input}
            placeholder="Email"
            value={emailInput}
            onChangeText={setEmailInput}
            autoCapitalize="none"
            keyboardType="email-address"
          />
          <TextInput
            style={styles.input}
            placeholder="Password"
            value={passwordInput}
            onChangeText={setPasswordInput}
            secureTextEntry
          />
          <Pressable style={styles.primaryButton} onPress={handleLogin}>
            <Text style={styles.primaryButtonText}>Sign In</Text>
          </Pressable>
          <Text style={styles.subtitle}>
            Demo: user@apsensi.local / Password09
          </Text>

          <View
            style={{
              flexDirection: "row",
              justifyContent: "center",
              marginTop: 20,
            }}
          >
            <Pressable
              onPress={() => {
                setTempIp(getApiBaseUrl());
                setIpModalVisible(true);
              }}
            >
              <Text
                style={{ color: "#007AFF", fontSize: 14, fontWeight: "600" }}
              >
                ⚙️ Server Config
              </Text>
            </Pressable>
          </View>
        </View>

        <Modal visible={ipModalVisible} transparent animationType="fade">
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>Server Configuration</Text>
              <Text style={styles.modalSubtitle}>
                Current: {getApiBaseUrl()}
              </Text>
              <TextInput
                style={[
                  styles.input,
                  { marginBottom: 16, borderWidth: 1, borderColor: "#ccc" },
                ]}
                value={tempIp}
                onChangeText={setTempIp}
                placeholder="http://localhost:4000"
                autoCapitalize="none"
              />
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Pressable
                  style={[styles.secondaryButton, { flex: 1 }]}
                  onPress={() => setIpModalVisible(false)}
                >
                  <Text style={styles.secondaryButtonText}>Cancel</Text>
                </Pressable>
                <Pressable
                  style={[styles.primaryButton, { flex: 1 }]}
                  onPress={() => {
                    setApiBaseUrl(tempIp);
                    import("./src/services/localDb").then((m) =>
                      m.saveServerConfig("api_base_url", tempIp),
                    );
                    setIpModalVisible(false);
                  }}
                >
                  <Text style={styles.primaryButtonText}>Save</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <View style={styles.topNav}>
        <View style={styles.topNavLine} />
      </View>
      <NavigationContainer>
        <Tab.Navigator
          screenOptions={({ route }) => ({
            tabBarActiveTintColor: "#007AFF",
            tabBarInactiveTintColor: "#8E8E93",
            headerShown: false,
            tabBarStyle: {
              position: "absolute",
              bottom: Platform.OS === "ios" ? 20 : 10,
              left: 20,
              right: 20,
              backgroundColor: "rgba(255, 255, 255, 0.75)",
              borderTopWidth: 0,
              height: 48,
              borderRadius: 24,
              elevation: 4,
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: 0.1,
              shadowRadius: 8,
            },
            tabBarLabelStyle: {
              fontSize: 10,
              marginBottom: 4,
              marginTop: 2,
            },
            tabBarIcon: ({ color, focused }) => {
              let iconName: any = "help";
              if (route.name === "Attendance")
                iconName = focused ? "location" : "location-outline";
              if (route.name === "Requests")
                iconName = focused ? "document-text" : "document-text-outline";
              if (route.name === "News")
                iconName = focused ? "newspaper" : "newspaper-outline";
              if (route.name === "Settings")
                iconName = focused ? "settings" : "settings-outline";
              if (route.name === "Approvals")
                iconName = focused
                  ? "checkmark-circle"
                  : "checkmark-circle-outline";

              return <Ionicons name={iconName} size={18} color={color} />;
            },
          })}
        >
          <Tab.Screen name="Attendance" options={{ tabBarLabel: "Absensi", tabBarLabelStyle: { fontSize: 10 } }}>
            {() => <AbsensiScreen user={user} onLogout={handleLogout} />}
          </Tab.Screen>
          <Tab.Screen name="Requests" options={{ tabBarLabel: "Requests", tabBarLabelStyle: { fontSize: 10 } }}>
            {() => <RequestsScreen user={user} />}
          </Tab.Screen>
          <Tab.Screen name="News" options={{ tabBarLabel: "News", tabBarLabelStyle: { fontSize: 10 } }}>
            {() => <BeritaScreen />}
          </Tab.Screen>
          {(user.role === "hrd" ||
            user.role === "admin" ||
            user.role === "manager_line") && (
            <Tab.Screen name="Approvals" options={{ tabBarLabel: "Approvals", tabBarLabelStyle: { fontSize: 10 } }}>
              {() => <ApprovalsScreen user={user} />}
            </Tab.Screen>
          )}
          <Tab.Screen name="Settings" options={{ tabBarLabel: "Settings", tabBarLabelStyle: { fontSize: 10 } }}>
            {() => <PengaturanScreen user={user} onLogout={handleLogout} onProfileUpdate={(updatedUser) => setUser(updatedUser)} />}
          </Tab.Screen>
        </Tab.Navigator>
      </NavigationContainer>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#f2f2f7",
    paddingTop: Platform.OS === "android" ? 25 : 0,
  },
  container: {
    flex: 1,
  },
  screenContainer: {
    paddingTop: Platform.OS === "ios" ? 60 : 50,
    paddingHorizontal: 16,
    paddingBottom: 60,
  },
  topNav: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(242,242,247,0.95)",
    zIndex: 100,
    paddingTop: Platform.OS === "ios" ? 8 : 0,
    borderBottomWidth: 0.5,
    borderBottomColor: "rgba(0,0,0,0.1)",
  },
  topNavLine: {
    width: 36,
    height: 4,
    backgroundColor: "rgba(0,0,0,0.3)",
    borderRadius: 2,
  },
  loginContainer: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    paddingTop: Platform.OS === "android" ? 40 : 20,
    gap: 16,
    backgroundColor: "#f2f2f7",
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: "#000000",
    textAlign: "center",
    marginBottom: 4,
  },
  subtitle: {
    color: "#8e8e93",
    fontSize: 13,
    textAlign: "center",
    marginBottom: 8,
  },
  input: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.05)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  primaryButton: {
    backgroundColor: "#007AFF",
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 16,
    paddingHorizontal: 20,
    shadowColor: "#007AFF",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  primaryButtonText: {
    color: "#ffffff",
    fontWeight: "600",
    fontSize: 16,
  },
  secondaryButton: {
    backgroundColor: "rgba(255,255,255,0.8)",
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.03)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  secondaryButtonText: {
    color: "#007AFF",
    fontWeight: "600",
    fontSize: 16,
  },
  destructiveButton: {
    backgroundColor: "rgba(255,59,48,0.1)",
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderWidth: 0,
    shadowColor: "#ff3b30",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  destructiveButtonText: {
    color: "#ff3b30",
    fontWeight: "600",
    fontSize: 16,
  },
  sectionLabel: {
    marginTop: 20,
    marginBottom: 12,
    fontWeight: "600",
    color: "#000000",
    fontSize: 16,
    paddingHorizontal: 4,
  },
  siteList: {
    gap: 10,
  },
  siteButton: {
    backgroundColor: "rgba(255,255,255,0.9)",
    borderRadius: 20,
    padding: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 2,
  },
  siteButtonActive: {
    backgroundColor: "#ffffff",
    shadowColor: "#007AFF",
    shadowOpacity: 0.2,
    shadowRadius: 16,
    borderWidth: 2,
    borderColor: "#007AFF",
  },
  siteName: {
    color: "#000000",
    fontWeight: "700",
    fontSize: 16,
  },
  siteNameActive: {
    color: "#007AFF",
  },
  siteMeta: {
    color: "#8e8e93",
    marginTop: 4,
    fontSize: 13,
  },
  actionRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 16,
  },
  flexButton: {
    flex: 1,
  },
  loadingRow: {
    marginTop: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  loadingText: {
    color: "#8e8e93",
    fontSize: 14,
  },
  infoText: {
    marginTop: 12,
    color: "#000000",
    fontSize: 14,
    textAlign: "center",
    paddingHorizontal: 8,
  },
  emptyText: {
    color: "#8e8e93",
    marginTop: 20,
    textAlign: "center",
    fontSize: 15,
  },
  recordCard: {
    backgroundColor: "rgba(255,255,255,0.9)",
    borderRadius: 20,
    padding: 16,
    marginBottom: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 2,
  },
  recordTitle: {
    fontWeight: "700",
    color: "#000000",
    fontSize: 16,
  },
  recordMeta: {
    color: "#8e8e93",
    marginTop: 4,
    fontSize: 13,
  },
  okText: {
    color: "#34c759",
    fontWeight: "500",
  },
  warnText: {
    color: "#ff9500",
    fontWeight: "500",
  },
  newsCard: {
    backgroundColor: "rgba(255,255,255,0.9)",
    borderRadius: 20,
    padding: 16,
    marginBottom: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 2,
  },
  newsTitle: {
    fontWeight: "700",
    fontSize: 18,
    color: "#000000",
    marginBottom: 6,
  },
  newsContent: {
    color: "#8e8e93",
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 8,
  },
  newsAuthor: {
    color: "#8e8e93",
    fontSize: 12,
    fontStyle: "italic",
  },
  newsDate: {
    color: "#8e8e93",
    fontSize: 12,
    marginTop: 2,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
    alignItems: "center",
  },
  modalContent: {
    backgroundColor: "#f2f2f7",
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    padding: 24,
    width: "100%",
    maxWidth: 600,
    paddingBottom: 40,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -10 },
    shadowOpacity: 0.15,
    shadowRadius: 20,
    elevation: 10,
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: "#000000",
    marginBottom: 6,
    textAlign: "center",
  },
  modalSubtitle: {
    color: "#8e8e93",
    fontSize: 13,
    marginBottom: 20,
    textAlign: "center",
  },
  modalHint: {
    color: "#8e8e93",
    fontSize: 12,
    marginTop: 12,
    marginBottom: 16,
    lineHeight: 18,
    textAlign: "center",
  },
  modalButtonRow: {
    flexDirection: "column",
    gap: 8,
    marginTop: 12,
  },
  statsContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 12,
  },
  statCard: {
    flex: 1,
    minWidth: "45%",
    backgroundColor: "rgba(255,255,255,0.9)",
    borderRadius: 20,
    padding: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 2,
  },
  statNumber: {
    fontSize: 32,
    fontWeight: "800",
    color: "#007AFF",
  },
  statLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#8e8e93",
    marginTop: 6,
  },
  profileCard: {
    backgroundColor: "rgba(255,255,255,0.95)",
    borderRadius: 20,
    padding: 20,
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 3,
  },
  profileImageContainer: {
    position: "relative",
    marginBottom: 16,
  },
  profileImage: {
    width: 100,
    height: 100,
    borderRadius: 50,
    borderWidth: 3,
    borderColor: "#007AFF",
  },
  profileImagePlaceholder: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: "#007AFF",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 3,
    borderColor: "#007AFF",
  },
  profileImagePlaceholderText: {
    fontSize: 40,
    fontWeight: "700",
    color: "#fff",
  },
  editPhotoBadge: {
    position: "absolute",
    bottom: 0,
    right: 0,
    backgroundColor: "#007AFF",
    borderRadius: 12,
    width: 24,
    height: 24,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
    borderColor: "#fff",
  },
  profileInfo: {
    alignItems: "center",
  },
  profileName: {
    fontSize: 22,
    fontWeight: "700",
    color: "#000000",
    marginBottom: 4,
  },
  profileJabatan: {
    fontSize: 16,
    color: "#8e8e93",
    marginBottom: 8,
  },
  profileDetail: {
    fontSize: 14,
    color: "#8e8e93",
    marginBottom: 4,
  },
  editForm: {
    width: "100%",
  },
  editInput: {
    backgroundColor: "#f2f2f7",
    borderRadius: 12,
    padding: 12,
    fontSize: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#e5e5ea",
  },
  editButtonRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
  },
});
