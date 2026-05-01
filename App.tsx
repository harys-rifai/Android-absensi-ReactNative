import { StatusBar } from "expo-status-bar";
import * as Location from "expo-location";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { PROJECT_SITES } from "./src/constants/sites";
import {
  fetchAttendanceRecords,
  loginUser,
  syncAttendanceRecords,
} from "./src/services/attendanceApi";
import {
  AttendanceRecord,
  EngineerUser,
  Site,
} from "./src/types/attendance";
import { haversineDistanceMeters } from "./src/utils/geofence";
import {
  cacheSignedInUser,
  getLocalAttendanceForUser,
  getUnsyncedAttendance,
  initializeLocalDb,
  insertSyncLog,
  markAttendanceSynced,
  saveCheckInLocal,
  saveCheckOutLocal,
} from "./src/services/localDb";

const formatTime = (iso: string): string => {
  return new Date(iso).toLocaleString("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
  });
};

export default function App() {
  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [user, setUser] = useState<EngineerUser | null>(null);
  const [selectedSiteId, setSelectedSiteId] = useState(PROJECT_SITES[0].id);
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [isBooting, setIsBooting] = useState(true);
  const [isLoadingRecords, setIsLoadingRecords] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastMessage, setLastMessage] = useState(
    "Belum ada aktivitas absensi."
  );

  const selectedSite: Site = useMemo(() => {
    const found = PROJECT_SITES.find((site) => site.id === selectedSiteId);
    return found ?? PROJECT_SITES[0];
  }, [selectedSiteId]);

  const loadAttendance = useCallback(async (signedUser: EngineerUser) => {
    setIsLoadingRecords(true);
    try {
      const remote = await fetchAttendanceRecords(signedUser.id, signedUser.role);
      setRecords(remote);
    } catch {
      const local = await getLocalAttendanceForUser(signedUser.id);
      setRecords(local);
      setLastMessage("Mode offline: menampilkan data dari SQLite lokal.");
    } finally {
      setIsLoadingRecords(false);
    }
  }, []);

  const runSync = useCallback(async (activeUser?: EngineerUser) => {
    const signedInUser = activeUser ?? user;
    if (!signedInUser || isSyncing) {
      return;
    }
    setIsSyncing(true);
    try {
      const unsynced = await getUnsyncedAttendance();
      if (unsynced.length === 0) {
        return;
      }

      const payload = unsynced.filter((row) => row.employee_id === signedInUser.id);
      if (payload.length === 0) {
        return;
      }

      const syncedRefs = await syncAttendanceRecords(payload);
      await markAttendanceSynced(syncedRefs);

      for (const clientRef of syncedRefs) {
        await insertSyncLog(clientRef, "success", "Synced to Postgres");
      }

      setLastMessage(`Sync sukses: ${syncedRefs.length} data terkirim.`);
      await loadAttendance(signedInUser);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Sync gagal ke server.";
      const unsynced = await getUnsyncedAttendance();
      for (const row of unsynced) {
        if (row.employee_id === signedInUser.id) {
          await insertSyncLog(row.client_ref, "failed", message);
        }
      }
      setLastMessage("Sync gagal. Data tetap aman di SQLite dan akan dicoba lagi.");
    }
    setIsSyncing(false);
  }, [isSyncing, loadAttendance, user]);

  useEffect(() => {
    const boot = async () => {
      await initializeLocalDb();
      setIsBooting(false);
    };
    void boot();
  }, []);

  useEffect(() => {
    if (!user) {
      return undefined;
    }
    const timer = setInterval(() => {
      void runSync();
    }, 15 * 60 * 1000);
    return () => clearInterval(timer);
  }, [runSync, user]);

  const handleLogin = async () => {
    const email = emailInput.trim().toLowerCase();
    const password = passwordInput.trim();
    if (!email || !password) {
      Alert.alert("Data belum lengkap", "Isi email dan password.");
      return;
    }

    setIsSubmitting(true);
    try {
      const signedUser = await loginUser({ email, password });
      setUser(signedUser);
      await cacheSignedInUser(signedUser);
      await loadAttendance(signedUser);
      await runSync(signedUser);
      setLastMessage(`Sign-in berhasil sebagai ${signedUser.role}.`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Login gagal.";
      Alert.alert("Login gagal", message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const submitAttendance = async (mode: "check-in" | "check-out") => {
    if (!user || user.role !== "user") {
      Alert.alert("Akses ditolak", "Hanya role user yang dapat check-in/check-out.");
      return;
    }

    setIsSubmitting(true);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") {
        Alert.alert(
          "Izin lokasi diperlukan",
          "Aktifkan izin lokasi agar absensi dapat dilakukan."
        );
        return;
      }

      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });

      const { latitude, longitude, accuracy } = position.coords;
      const distance = haversineDistanceMeters(
        latitude,
        longitude,
        selectedSite.latitude,
        selectedSite.longitude
      );
      const withinGeofence = distance <= selectedSite.radiusMeters;
      const locationType = withinGeofence ? "onsite" : "offsite";

      if (mode === "check-in") {
        await saveCheckInLocal(user.id, latitude, longitude, locationType);
      } else {
        const updated = await saveCheckOutLocal(
          user.id,
          latitude,
          longitude,
          locationType
        );
        if (!updated) {
          Alert.alert("Check-out gagal", "Tidak ada data check-in yang terbuka.");
          return;
        }
      }

      setLastMessage(
        `${mode === "check-in" ? "Check-in" : "Check-out"} disimpan lokal (${
          locationType === "onsite" ? "di dalam area" : "di luar area"
        }, jarak ${Math.round(distance)}m).`
      );
      await loadAttendance(user);
      await runSync(user);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Terjadi kesalahan tidak diketahui.";
      Alert.alert("Gagal absensi", message);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isBooting) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.loginContainer}>
          <ActivityIndicator />
          <Text style={styles.subtitle}>Menyiapkan database lokal SQLite...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!user) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        <View style={styles.loginContainer}>
          <Text style={styles.title}>Hybrid Attendance</Text>
          <Text style={styles.subtitle}>
            Login dibaca dari Postgres, user disimpan manual ke SQLite.
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
          <Pressable
            style={styles.primaryButton}
            onPress={handleLogin}
            disabled={isSubmitting}
          >
            <Text style={styles.primaryButtonText}>Masuk</Text>
          </Pressable>
          <Text style={styles.subtitle}>
            Demo account: user@apsensi.local / Password09
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.screenContainer}>
        <Text style={styles.title}>Halo, {user.name}</Text>
        <Text style={styles.subtitle}>
          Role: {user.role}. Auto-sync ke Postgres setiap 15 menit.
        </Text>

        {user.role === "user" ? (
          <>
            <Text style={styles.sectionLabel}>Pilih site project</Text>
            <View style={styles.siteList}>
              {PROJECT_SITES.map((site) => {
                const active = site.id === selectedSiteId;
                return (
                  <Pressable
                    key={site.id}
                    style={[styles.siteButton, active && styles.siteButtonActive]}
                    onPress={() => setSelectedSiteId(site.id)}
                  >
                    <Text style={[styles.siteName, active && styles.siteNameActive]}>
                      {site.name}
                    </Text>
                    <Text style={[styles.siteMeta, active && styles.siteNameActive]}>
                      Radius {site.radiusMeters}m
                    </Text>
                  </Pressable>
                );
              })}
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
          </>
        ) : null}

        <View style={styles.actionRow}>
          <Pressable
            style={[styles.secondaryButton, styles.flexButton]}
            disabled={isSyncing}
            onPress={() => {
              void runSync();
            }}
          >
            <Text style={styles.secondaryButtonText}>
              {isSyncing ? "Sync..." : "Sync Sekarang"}
            </Text>
          </Pressable>
          {user.role === "hrd" ? (
            <Pressable
              style={[styles.secondaryButton, styles.flexButton]}
              onPress={() =>
                Alert.alert(
                  "Export CSV",
                  "Akses endpoint: /attendance/export?role=hrd pada API."
                )
              }
            >
              <Text style={styles.secondaryButtonText}>Info Export</Text>
            </Pressable>
          ) : null}
        </View>

        {isSubmitting ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator />
            <Text style={styles.loadingText}>Mengambil lokasi GPS...</Text>
          </View>
        ) : null}

        <Text style={styles.infoText}>{lastMessage}</Text>

        <Text style={styles.sectionLabel}>Riwayat absensi</Text>
        {isLoadingRecords ? (
          <ActivityIndicator />
        ) : (
          <FlatList
            data={records}
            keyExtractor={(item) =>
              item.client_ref || String(item.id ?? Math.random())
            }
            scrollEnabled={false}
            ListEmptyComponent={
              <Text style={styles.emptyText}>Belum ada data absensi.</Text>
            }
            renderItem={({ item }) => (
              <View style={styles.recordCard}>
                <Text style={styles.recordTitle}>
                  {(item.employee_name ?? user.name) +
                    (item.check_out ? " (Selesai)" : " (Aktif)")}
                </Text>
                <Text style={styles.recordMeta}>
                  Check-in: {item.check_in ? formatTime(item.check_in) : "-"}
                </Text>
                <Text
                  style={[
                    styles.recordMeta,
                    item.synced ? styles.okText : styles.warnText,
                  ]}
                >
                  {item.check_out
                    ? `Check-out: ${formatTime(item.check_out)}`
                    : "Belum check-out"}
                </Text>
                <Text
                  style={[
                    styles.recordMeta,
                    item.synced ? styles.okText : styles.warnText,
                  ]}
                >
                  {item.synced ? "Synced ke Postgres" : "Belum synced (SQLite)"}
                </Text>
              </View>
            )}
          />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#f5f7fb",
  },
  screenContainer: {
    padding: 18,
    paddingBottom: 32,
  },
  loginContainer: {
    flex: 1,
    justifyContent: "center",
    padding: 20,
    gap: 12,
    backgroundColor: "#f5f7fb",
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    color: "#111827",
  },
  subtitle: {
    color: "#4b5563",
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#ffffff",
  },
  primaryButton: {
    backgroundColor: "#1d4ed8",
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  primaryButtonText: {
    color: "#ffffff",
    fontWeight: "600",
  },
  sectionLabel: {
    marginTop: 18,
    marginBottom: 10,
    fontWeight: "700",
    color: "#111827",
  },
  siteList: {
    gap: 8,
  },
  siteButton: {
    backgroundColor: "#e5e7eb",
    borderRadius: 8,
    padding: 12,
  },
  siteButtonActive: {
    backgroundColor: "#bfdbfe",
    borderWidth: 1,
    borderColor: "#3b82f6",
  },
  siteName: {
    color: "#111827",
    fontWeight: "600",
  },
  siteNameActive: {
    color: "#1e3a8a",
  },
  siteMeta: {
    color: "#374151",
    marginTop: 2,
  },
  actionRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 14,
  },
  flexButton: {
    flex: 1,
  },
  secondaryButton: {
    backgroundColor: "#ffffff",
    borderRadius: 8,
    borderColor: "#1d4ed8",
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  secondaryButtonText: {
    color: "#1d4ed8",
    fontWeight: "600",
  },
  loadingRow: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  loadingText: {
    color: "#4b5563",
  },
  infoText: {
    marginTop: 10,
    color: "#1f2937",
  },
  emptyText: {
    color: "#6b7280",
    marginTop: 6,
  },
  recordCard: {
    backgroundColor: "#ffffff",
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  recordTitle: {
    fontWeight: "700",
    color: "#111827",
  },
  recordMeta: {
    color: "#4b5563",
    marginTop: 2,
  },
  okText: {
    color: "#166534",
  },
  warnText: {
    color: "#b45309",
  },
});
