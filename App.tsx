import { StatusBar } from "expo-status-bar";
import * as Location from "expo-location";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { NavigationContainer } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Platform,
} from "react-native";
import { PROJECT_SITES } from "./src/constants/sites";
import {
  fetchAttendanceRecords,
  fetchNews,
  getApiBaseUrl,
  loginUser,
  setApiBaseUrl,
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
  getCachedUser,
  getLocalAttendanceForUser,
  getLocalNews,
  getLocalUser,
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
} from "./src/services/localDb";

const Tab = createBottomTabNavigator();

// === Timezone Utilities (Jakarta/Indonesia UTC+7) ===
const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000; // UTC+7 in milliseconds

const toJakartaTime = (date: Date): Date => {
  // Add UTC+7 offset to get Jakarta time
  return new Date(date.getTime() + JAKARTA_OFFSET_MS);
};

const getJakartaDateString = (date: Date): string => {
  const jakarta = toJakartaTime(date);
  return `${jakarta.getUTCFullYear()}-${String(jakarta.getUTCMonth() + 1).padStart(2, '0')}-${String(jakarta.getUTCDate()).padStart(2, '0')}`;
};

const isSameDayJakarta = (d1: Date, d2: Date) => {
  const j1 = toJakartaTime(d1);
  const j2 = toJakartaTime(d2);
  return j1.getFullYear() === j2.getFullYear() &&
    j1.getMonth() === j2.getMonth() &&
    j1.getDate() === j2.getDate();
};

const isLate = (checkInStr: string) => {
  try {
    const d = new Date(checkInStr);
    const jakarta = toJakartaTime(d);
    const hours = jakarta.getHours();
    const minutes = jakarta.getMinutes();
    return (hours > 9) || (hours === 9 && minutes > 0);
  } catch {
    return false;
  }
};

// Indonesian Holidays 2026 (sample - add more as needed)
const HOLIDAYS_2026 = [
  '2026-01-01', // New Year
  '2026-01-29', // Chinese New Year
  '2026-03-29', // Nyepi
  '2026-04-03', // Good Friday
  '2026-05-01', // Labor Day
  '2026-05-13', // Ascension of Jesus
  '2026-05-29', // Waisak
  '2026-06-01', // Pancasila Day
  '2026-06-06', // Eid al-Fitr (estimated)
  '2026-06-07', // Eid al-Fitr (estimated)
  '2026-08-17', // Independence Day
  '2026-09-12', // Eid al-Adha (estimated)
  '2026-10-01', // Islamic New Year (estimated)
  '2026-12-25', // Christmas
];

const isHoliday = (date: Date): boolean => {
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return HOLIDAYS_2026.includes(dateStr);
};

  const formatTime = (iso: string): string => {
    try {
      const d = new Date(iso);
      const jakarta = toJakartaTime(d);
      return jakarta.toLocaleString("id-ID", {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    } catch {
      return iso;
    }
  };

  const formatDateJakarta = (date: Date): string => {
    const jakarta = toJakartaTime(date);
    return jakarta.toLocaleString('id-ID', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  };

function AbsensiScreen({ user, onLogout }: { user: EngineerUser; onLogout: () => void }) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastMessage, setLastMessage] = useState("No attendance activity yet.");
  const [isSyncing, setIsSyncing] = useState(false);
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [isLoadingRecords, setIsLoadingRecords] = useState(false);
  const [userSite, setUserSite] = useState<Site | null>(null);

  const selectedSite: Site = userSite ?? PROJECT_SITES[0];

  useEffect(() => {
    if (user.site_id) {
      const site = PROJECT_SITES.find(s => s.id === user.site_id);
      if (site) setUserSite(site);
    }
  }, [user.site_id]);

  const loadAttendance = useCallback(async () => {
    setIsLoadingRecords(true);
    try {
      const local = await getLocalAttendanceForUser(user.id);
      try {
        const remote = await fetchAttendanceRecords(user.id, user.role);
        const recordMap = new Map();
        for (const r of remote) {
          const key = r.client_ref || String(r.id);
          recordMap.set(key, r);
        }
        for (const r of local) {
          const key = r.client_ref || String(r.id);
          recordMap.set(key, r);
        }
        setRecords(Array.from(recordMap.values()));
      } catch {
        setRecords(local);
      }
    } catch {
      setRecords([]);
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
      const message = error instanceof Error ? error.message : "Sync failed to server.";
      setLastMessage("Sync failed. Data remains safe in local storage.");
    }
    setIsSyncing(false);
  }, [isSyncing, user, loadAttendance]);

  useEffect(() => {
    loadAttendance();
    const timer = setInterval(() => { void runSync(); }, 15 * 60 * 1000);
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
            [{ text: "OK" }]
          );
          setIsSubmitting(false);
          return;
        }
      }

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("GPS timeout.")), 30000)
      );
      const locationPromise = Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });

      const position = await Promise.race([locationPromise, timeoutPromise]) as Location.LocationObject;
      const { latitude, longitude, accuracy } = position.coords;

      if (accuracy && accuracy > 100) {
        Alert.alert("Low GPS Accuracy", `Accuracy: ${Math.round(accuracy)}m. Continue anyway?`, [
          { text: "Retry", onPress: () => { setIsSubmitting(false); } },
          { text: "Continue", onPress: () => submitAttendance(mode) },
        ]);
        return;
      }

      const distance = haversineDistanceMeters(latitude, longitude, selectedSite.latitude, selectedSite.longitude);
      const locationType = distance <= selectedSite.radiusMeters ? "onsite" : "offsite";

      // Get today's date in Jakarta timezone
      const now = new Date();
      const todayJakarta = getJakartaDateString(now);

      // Filter today's records using Jakarta date
      const todayRecords = records.filter(r => {
        if (!r.check_in) return false;
        const checkInDate = getJakartaDateString(new Date(r.check_in));
        return checkInDate === todayJakarta;
      });

      if (mode === "check-in") {
        if (todayRecords.length > 0) {
          Alert.alert("Already Checked In", "You have already checked in today.");
          setIsSubmitting(false);
          return;
        }
        const checkInSuccess = await saveCheckInLocal(user.id, latitude, longitude, locationType);
        if (!checkInSuccess) {
          Alert.alert("Check-in Failed", "You have already checked in today. Only one check-in per day is allowed.");
          setIsSubmitting(false);
          return;
        }
        setLastMessage(`Check-in successful at ${locationType === "onsite" ? "inside" : "outside"} area`);
      } else {
        const hasOpenCheckin = todayRecords.some(r => !r.check_out);
        if (!hasOpenCheckin) {
          Alert.alert("No Check-in", "You haven't checked in today.");
          setIsSubmitting(false);
          return;
        }
        const checkOutSuccess = await saveCheckOutLocal(user.id, latitude, longitude, locationType);
        if (!checkOutSuccess) {
          Alert.alert("Check-out Failed", "You have already checked out today. Only one check-out per day is allowed.");
          setIsSubmitting(false);
          return;
        }
        setLastMessage(`Check-out successful at ${locationType === "onsite" ? "inside" : "outside"} area`);
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
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    } catch {
      return iso;
    }
  };

  const getDayStatus = (day: number) => {
    const jakartaSelected = toJakartaTime(selectedDate);
    const dateStr = `${jakartaSelected.getFullYear()}-${String(jakartaSelected.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dayRecords = records.filter(r => {
      if (!r.check_in) return false;
      const checkInJakarta = getJakartaDateString(new Date(r.check_in));
      return checkInJakarta === dateStr;
    });
    const todayJakarta = toJakartaTime(new Date());
    const dayDate = new Date(jakartaSelected.getFullYear(), jakartaSelected.getMonth(), day);

    // Check if holiday
    if (isHoliday(dayDate)) {
      return 'holiday';
    }

    if (dayRecords.length === 0) {
      if (dayDate < todayJakarta && !isSameDayJakarta(dayDate, todayJakarta)) {
        return 'no-checkin';
      }
      if (dayDate > todayJakarta) return 'future';
      return 'none';
    }

    const hasLate = dayRecords.some(r => r.check_in && isLate(r.check_in));
    if (hasLate) return 'late';

    const hasCheckout = dayRecords.some(r => r.check_out);
    const hasForgetCheckout = dayRecords.some(r => !r.check_out);
    
    if (hasCheckout) return 'checked-out';  // Blue for complete attendance
    if (hasForgetCheckout) return 'forget-checkout'; // Purple for no checkout

    return 'checked-in'; // Green for check-in only
  };

  const getDaysInMonth = (date: Date) => {
    const jakarta = toJakartaTime(date);
    return new Date(jakarta.getFullYear(), jakarta.getMonth() + 1, 0).getDate();
  };

  const getFirstDayOfMonth = (date: Date) => {
    const jakarta = toJakartaTime(date);
    return new Date(jakarta.getFullYear(), jakarta.getMonth(), 1).getDay();
  };

  const renderCalendar = () => {
    const daysInMonth = getDaysInMonth(selectedDate);
    const firstDay = getFirstDayOfMonth(selectedDate);
    const days = [];
    const todayJakarta = toJakartaTime(new Date());

    for (let i = 0; i < firstDay; i++) {
      days.push(<View key={`empty-${i}`} style={styles.calendarDay} />);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const status = getDayStatus(day);
      const calendarDate = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), day);
      const isToday = isSameDayJakarta(calendarDate, todayJakarta);
      const isSelected = selectedDate.getDate() === day;

      let dayStyle: any[] = [styles.calendarDay];
      let textStyle: any[] = [styles.calendarDayText];

      // Colors per roleCalender.md: Green=Check-in, Blue=Check-out, Yellow=Late, Orange=No Check-in, Purple=No Check-out
      if (status === 'checked-in') {
        // Green for check-in only
        dayStyle.push({ backgroundColor: '#34c759' });
        textStyle.push({ color: '#fff' });
      } else if (status === 'checked-out') {
        // Blue for complete (check-in + check-out)
        dayStyle.push({ backgroundColor: '#007AFF' });
        textStyle.push({ color: '#fff' });
      } else if (status === 'late') {
        // Yellow for late
        dayStyle.push({ backgroundColor: '#ffcc00' });
        textStyle.push({ color: '#000' });
      } else if (status === 'no-checkin') {
        // Orange for no check-in
        dayStyle.push({ backgroundColor: '#ff9500' });
        textStyle.push({ color: '#fff' });
      } else if (status === 'forget-checkout') {
        // Purple for no check-out
        dayStyle.push({ backgroundColor: '#af52de' });
        textStyle.push({ color: '#fff' });
      } else if (status === 'holiday') {
        textStyle.push({ color: '#ff3b30', fontWeight: '600' });
      }

      if (isToday) {
        dayStyle.push(styles.calendarDayToday);
      }
      if (isSelected) {
        dayStyle.push(styles.calendarDayActive);
        textStyle.push(styles.calendarDayActiveText);
      }

      days.push(
        <Pressable
          key={day}
          style={dayStyle}
          onPress={() => setSelectedDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), day))}
        >
          <Text style={textStyle}>{day}</Text>
        </Pressable>
      );
    }

    return days;
  };

  const selectedDayRecords = (() => {
    const jakartaSelected = toJakartaTime(selectedDate);
    const dateStr = getJakartaDateString(selectedDate);
    return records.filter(r => {
      if (!r.check_in) return false;
      const checkInJakarta = getJakartaDateString(new Date(r.check_in));
      return checkInJakarta === dateStr;
    });
  })();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.screenContainer}>
      <Text style={styles.title}>Hello, {user.name}</Text>
      <Text style={styles.subtitle}>Role: {user.role}{userSite ? ` • ${userSite.name}` : ''}</Text>

      {isSubmitting ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator />
          <Text style={styles.loadingText}>Getting GPS location...</Text>
        </View>
      ) : null}
      <Text style={styles.infoText}>{lastMessage}</Text>

      <Text style={[styles.sectionLabel, { marginTop: 20 }]}>Calendar</Text>
      <View style={styles.calendarContainer}>
        <View style={styles.calendarHeader}>
          <Pressable onPress={() => setSelectedDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth() - 1))}>
            <Text style={{ color: '#007AFF', fontSize: 18 }}>‹</Text>
          </Pressable>
          <Text style={styles.calendarTitle}>
            {formatDateJakarta(selectedDate)}
          </Text>
          <Pressable onPress={() => setSelectedDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1))}>
            <Text style={{ color: '#007AFF', fontSize: 18 }}>›</Text>
          </Pressable>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' }}>
          {['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'].map(d => (
            <Text key={d} style={{ width: 36, textAlign: 'center', fontSize: 10, color: '#8e8e93', margin: 2 }}>{d}</Text>
          ))}
          {renderCalendar()}
        </View>
      </View>

      <View style={{ marginTop: 16 }}>
        <Text style={{ fontSize: 14, fontWeight: '600', color: '#000', marginBottom: 8 }}>
          {toJakartaTime(selectedDate).toLocaleString('id-ID', { day: 'numeric', month: 'long' })}
        </Text>
        {selectedDayRecords.length > 0 ? selectedDayRecords.map((item, idx) => (
          <View key={idx} style={styles.recordCard}>
            <Text style={styles.recordTitle}>
              {item.employee_name ?? user.name}
            </Text>
            <Text style={styles.recordMeta}>Check-in: {item.check_in ? formatTimeJakarta(item.check_in) : "-"}</Text>
            <Text style={styles.recordMeta}>
              {item.check_out ? `Check-out: ${formatTimeJakarta(item.check_out)}` : "Not checked out"}
            </Text>
            <Text style={[styles.recordMeta, item.synced ? styles.okText : styles.warnText]}>
              {item.synced ? "✓ Synced" : "⏳ Pending"}
            </Text>
          </View>
        )) : (
          <Text style={styles.emptyText}>No attendance on this day</Text>
        )}
      </View>

      {/* Show recent attendance history below calendar */}
      <View style={{ marginTop: 20 }}>
        <Text style={[styles.sectionLabel, { marginTop: 0 }]}>Recent History</Text>
        {records.length > 0 ? records
          .filter(r => r.check_in)
          .sort((a, b) => new Date(b.check_in!).getTime() - new Date(a.check_in!).getTime())
          .slice(0, 5)
          .map((item, idx) => (
            <View key={idx} style={styles.recordCard}>
              <Text style={styles.recordMeta}>
                {toJakartaTime(new Date(item.check_in!)).toLocaleString('id-ID', { day: 'numeric', month: 'short' })}
              </Text>
              <Text style={styles.recordTitle}>
                {item.employee_name ?? user.name}
              </Text>
              <Text style={styles.recordMeta}>Check-in: {item.check_in ? formatTimeJakarta(item.check_in) : "-"}</Text>
              <Text style={styles.recordMeta}>
                {item.check_out ? `Check-out: ${formatTimeJakarta(item.check_out)}` : "Not checked out"}
              </Text>
            </View>
          )) : (
          <Text style={styles.emptyText}>No attendance history</Text>
        )}
      </View>

      <View style={styles.actionRow}>
        <Pressable style={[styles.primaryButton, styles.flexButton]} disabled={isSubmitting} onPress={() => submitAttendance("check-in")}>
          <Text style={styles.primaryButtonText}>Check-in</Text>
        </Pressable>
        <Pressable style={[styles.secondaryButton, styles.flexButton]} disabled={isSubmitting} onPress={() => submitAttendance("check-out")}>
          <Text style={styles.secondaryButtonText}>Check-out</Text>
        </Pressable>
      </View>

      <View style={styles.actionRow}>
        <Pressable style={[styles.secondaryButton, styles.flexButton]} disabled={isSyncing} onPress={() => { void runSync(); }}>
          <Text style={styles.secondaryButtonText}>{isSyncing ? "Syncing..." : "Sync Now"}</Text>
        </Pressable>
      </View>

       <View style={{ marginTop: 12, padding: 10, backgroundColor: '#fff', borderRadius: 12 }}>
         <Text style={{ fontSize: 12, color: '#8e8e93', marginBottom: 6 }}>Legend:</Text>
         <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
           <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
             <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: '#34c759' }} />
             <Text style={{ fontSize: 10, color: '#8e8e93' }}>Check-in</Text>
           </View>
           <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
             <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: '#007AFF' }} />
             <Text style={{ fontSize: 10, color: '#8e8e93' }}>Check-out</Text>
           </View>
           <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
             <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: '#ffcc00' }} />
             <Text style={{ fontSize: 10, color: '#8e8e93' }}>Late</Text>
           </View>
           <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
             <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: '#ff9500' }} />
             <Text style={{ fontSize: 10, color: '#8e8e93' }}>No Check-in</Text>
           </View>
           <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
             <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: '#af52de' }} />
             <Text style={{ fontSize: 10, color: '#8e8e93' }}>No Check-out</Text>
           </View>
           <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
             <Text style={{ fontSize: 10, color: '#ff3b30', fontWeight: '600' }}>Red Text = Holiday</Text>
           </View>
         </View>
       </View>
    </ScrollView>
  );
}

function RiwayatScreen({ user }: { user: EngineerUser }) {
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [viewMode, setViewMode] = useState<'calendar' | 'list'>('calendar');

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
        const payload = unsynced.filter((row) => row.employee_id === user.id || user.role === 'hrd' || user.role === 'admin');
        if (payload.length > 0) {
          await syncAttendanceRecords(payload);
          await markAttendanceSynced(payload.map(r => r.client_ref!).filter(Boolean));
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
    const timer = setInterval(() => { void syncAndReload(); }, 15 * 60 * 1000);
    return () => clearInterval(timer);
  }, [syncAndReload]);

  const getDaysInMonthRiwayat = (date: Date) => {
    const jakarta = toJakartaTime(date);
    return new Date(jakarta.getFullYear(), jakarta.getMonth() + 1, 0).getDate();
  };

  const getFirstDayOfMonthRiwayat = (date: Date) => {
    const jakarta = toJakartaTime(date);
    return new Date(jakarta.getFullYear(), jakarta.getMonth(), 1).getDay();
  };

  const hasAttendanceOnDay = (day: number) => {
    const jakartaSelected = toJakartaTime(selectedDate);
    const dateStr = `${jakartaSelected.getFullYear()}-${String(jakartaSelected.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return records.some(r => {
      if (!r.check_in) return false;
      const checkInJakarta = getJakartaDateString(new Date(r.check_in));
      return checkInJakarta === dateStr;
    });
  };

  const getRecordsForDay = (day: number) => {
    const jakartaSelected = toJakartaTime(selectedDate);
    const dateStr = `${jakartaSelected.getFullYear()}-${String(jakartaSelected.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return records.filter(r => {
      if (!r.check_in) return false;
      const checkInJakarta = getJakartaDateString(new Date(r.check_in));
      return checkInJakarta === dateStr;
    });
  };

  const renderCalendarRiwayat = () => {
    const daysInMonth = getDaysInMonthRiwayat(selectedDate);
    const firstDay = getFirstDayOfMonthRiwayat(selectedDate);
    const days = [];
    const todayJakarta = toJakartaTime(new Date());

    for (let i = 0; i < firstDay; i++) {
      days.push(<View key={`empty-${i}`} style={styles.calendarDay} />);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const hasRecord = hasAttendanceOnDay(day);
      const calendarDate = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), day);
      const isToday = isSameDayJakarta(calendarDate, todayJakarta);

      days.push(
        <Pressable
          key={day}
          style={[
            styles.calendarDay,
            hasRecord && styles.calendarDayActive,
            isToday && styles.calendarDayToday,
          ]}
          onPress={() => setSelectedDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), day))}
        >
          <Text style={[
            styles.calendarDayText,
            hasRecord && styles.calendarDayActiveText,
          ]}>{day}</Text>
        </Pressable>
      );
    }

    return days;
  };

  const selectedDayRecords = getRecordsForDay(selectedDate.getDate());

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.screenContainer}>
      <View style={styles.sectionLabel}>
        <Text style={{fontSize: 16, fontWeight: '600'}}>Attendance History</Text>
        <View style={{flexDirection: 'row', gap: 8, marginTop: 8}}>
          <Pressable
            style={[styles.secondaryButton, {flex: 1, paddingVertical: 8}]}
            onPress={() => setViewMode('calendar')}
          >
            <Text style={[styles.secondaryButtonText, {fontSize: 12}, viewMode === 'calendar' && {color: '#007AFF'}]}>Calendar</Text>
          </Pressable>
          <Pressable
            style={[styles.secondaryButton, {flex: 1, paddingVertical: 8}]}
            onPress={() => setViewMode('list')}
          >
            <Text style={[styles.secondaryButtonText, {fontSize: 12}, viewMode === 'list' && {color: '#007AFF'}]}>List</Text>
          </Pressable>
        </View>
      </View>

      {viewMode === 'calendar' ? (
        <>
          <View style={styles.calendarContainer}>
            <View style={styles.calendarHeader}>
              <Pressable onPress={() => setSelectedDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth() - 1))}>
                <Text style={{color: '#007AFF', fontSize: 16}}>‹</Text>
              </Pressable>
              <Text style={styles.calendarTitle}>
                {selectedDate.toLocaleString('id-ID', { month: 'long', year: 'numeric' })}
              </Text>
              <Pressable onPress={() => setSelectedDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1))}>
                <Text style={{color: '#007AFF', fontSize: 16}}>›</Text>
              </Pressable>
            </View>
            <View style={{flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center'}}>
              {['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'].map(d => (
                <Text key={d} style={{width: 36, textAlign: 'center', fontSize: 10, color: '#8e8e93', margin: 2}}>{d}</Text>
              ))}
              {renderCalendarRiwayat()}
            </View>
          </View>

          <View style={{marginTop: 16}}>
            <Text style={{fontSize: 14, fontWeight: '600', color: '#000', marginBottom: 8}}>
              {toJakartaTime(selectedDate).toLocaleString('id-ID', { day: 'numeric', month: 'long' })}
            </Text>
            {selectedDayRecords.length > 0 ? selectedDayRecords.map((item, idx) => (
              <View key={idx} style={styles.recordCard}>
                <Text style={styles.recordTitle}>
                  {item.employee_name ?? user.name}
                </Text>
                <Text style={styles.recordMeta}>Check-in: {item.check_in ? formatTime(item.check_in) : "-"}</Text>
                <Text style={styles.recordMeta}>
                  {item.check_out ? `Check-out: ${formatTime(item.check_out)}` : "Not checked out"}
                </Text>
                <Text style={[styles.recordMeta, item.synced ? styles.okText : styles.warnText]}>
                  {item.synced ? "✓ Synced" : "⏳ Pending"}
                </Text>
              </View>
            )) : (
              <Text style={styles.emptyText}>No attendance on this day</Text>
            )}
          </View>
        </>
      ) : (
        <>
          <View style={styles.actionRow}>
            <Pressable style={[styles.secondaryButton, styles.flexButton]} disabled={isLoading} onPress={() => { void syncAndReload(); }}>
              <Text style={styles.secondaryButtonText}>{isLoading ? "Syncing..." : "Sync & Refresh"}</Text>
            </Pressable>
          </View>
          {isLoading ? (
            <ActivityIndicator />
          ) : (
            <FlatList
              data={records}
              keyExtractor={(item) => item.client_ref || String(item.id ?? Math.random())}
              scrollEnabled={false}
              ListEmptyComponent={<Text style={styles.emptyText}>No attendance records yet.</Text>}
              renderItem={({ item }) => (
                <View style={styles.recordCard}>
                  <Text style={styles.recordTitle}>
                    {(item.employee_name ?? user.name) + (item.check_out ? " (Completed)" : " (Active)")}
                  </Text>
                  <Text style={styles.recordMeta}>Check-in: {item.check_in ? formatTime(item.check_in) : "-"}</Text>
                  <Text style={[styles.recordMeta, item.synced ? styles.okText : styles.warnText]}>
                    {item.check_out ? `Check-out: ${formatTime(item.check_out)}` : "Not checked out yet"}
                  </Text>
                  <Text style={[styles.recordMeta, item.synced ? styles.okText : styles.warnText]}>
                    {item.synced ? "Synced to server" : "Not synced (local)"}
                  </Text>
                </View>
              )}
            />
          )}
        </>
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
    const timer = setInterval(() => { void loadNews(); }, 15 * 60 * 1000);
    return () => clearInterval(timer);
  }, [loadNews]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.screenContainer}>
      <Text style={styles.title}>News & Updates</Text>
      {isLoading ? (
        <ActivityIndicator />
      ) : (
        <FlatList
          data={news}
          keyExtractor={(item) => String(item.remote_id || item.id)}
          scrollEnabled={false}
          ListEmptyComponent={<Text style={styles.emptyText}>No news available.</Text>}
          renderItem={({ item }) => (
            <View style={styles.newsCard}>
              <Text style={styles.newsTitle}>{item.title}</Text>
              <Text style={styles.newsContent}>{item.content}</Text>
              {item.author_name ? <Text style={styles.newsAuthor}>By: {item.author_name}</Text> : null}
              {item.published_at ? (
                <Text style={styles.newsDate}>
                  {new Date(item.published_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
                </Text>
              ) : null}
            </View>
          )}
        />
      )}
      <Pressable style={[styles.secondaryButton, { marginTop: 12 }]} onPress={() => { void loadNews(); }}>
        <Text style={styles.secondaryButtonText}>{isLoading ? "Loading..." : "Refresh News"}</Text>
      </Pressable>
    </ScrollView>
  );
}

type RequestItem = {
  id: number;
  employee_id: number;
  employee_name?: string;
  type: 'leave' | 'overtime' | 'late' | 'off';
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
  const [activeTab, setActiveTab] = useState<'all' | 'leave' | 'overtime' | 'late' | 'off'>('all');

  const loadRequests = useCallback(async () => {
    setIsLoading(true);
    try {
      const [leaveRes, overtimeRes] = await Promise.all([
        fetch(`/leave?requesterId=${user.id}&role=${user.role}`).then(r => r.json()),
        fetch(`/overtime?requesterId=${user.id}&role=${user.role}`).then(r => r.json()),
      ]);

      const items: RequestItem[] = [
        ...(leaveRes || []).map((r: any) => ({ ...r, type: 'leave' as const })),
        ...(overtimeRes || []).map((r: any) => ({ ...r, type: 'overtime' as const })),
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
    const timer = setInterval(() => { void loadRequests(); }, 15 * 60 * 1000);
    return () => clearInterval(timer);
  }, [loadRequests]);

  const filteredRequests = activeTab === 'all' ? requests :
    requests.filter(r => r.type === activeTab);

  const getStatusColor = (status: string) => {
    if (status.includes('approved')) return '#34c759';
    if (status.includes('rejected')) return '#ff3b30';
    if (status.includes('pending')) return '#ffcc00';
    return '#8e8e93';
  };

  const getStatusText = (item: RequestItem) => {
    if (item.type === 'leave') {
      if (item.status === 'approved') return '✓ Approved';
      if (item.status === 'pending_hrd') return '⏳ Waiting HRD';
      if (item.status === 'pending_manager') return '⏳ Waiting Manager';
      if (item.status === 'rejected') return '✗ Rejected';
    }
    return item.status;
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.screenContainer}>
      <Text style={styles.title}>Requests</Text>
      <Text style={styles.subtitle}>Manage your requests</Text>

      <View style={{ flexDirection: 'row', gap: 6, marginTop: 12, marginBottom: 12 }}>
        {(['all', 'leave', 'overtime', 'late', 'off'] as const).map(tab => (
          <Pressable
            key={tab}
            style={[
              styles.secondaryButton,
              { flex: 1, paddingVertical: 8 },
              activeTab === tab && { backgroundColor: '#007AFF' }
            ]}
            onPress={() => setActiveTab(tab)}
          >
            <Text style={[styles.secondaryButtonText, activeTab === tab && { color: '#fff' }, { fontSize: 11 }]}>
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </Text>
          </Pressable>
        ))}
      </View>

      <Pressable style={[styles.secondaryButton, { marginBottom: 12 }]} onPress={() => { void loadRequests(); }}>
        <Text style={styles.secondaryButtonText}>{isLoading ? "Loading..." : "Refresh"}</Text>
      </Pressable>

      {isLoading ? <ActivityIndicator /> : (
        filteredRequests.length > 0 ? (
          filteredRequests.map((item, idx) => (
            <View key={idx} style={styles.recordCard}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={styles.recordTitle}>
                  {item.employee_name ?? 'Employee'} - {item.type.charAt(0).toUpperCase() + item.type.slice(1)}
                </Text>
                <View style={{ backgroundColor: getStatusColor(item.status), paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 }}>
                  <Text style={{ color: '#fff', fontSize: 10, fontWeight: '600' }}>{getStatusText(item)}</Text>
                </View>
              </View>
              {item.type === 'leave' && (
                <>
                  <Text style={styles.recordMeta}>Period: {item.start_date} s/d {item.end_date}</Text>
                  {item.manager_remark && <Text style={styles.recordMeta}>Manager Remark: {item.manager_remark}</Text>}
                  {item.hrd_remark && <Text style={styles.recordMeta}>HRD Remark: {item.hrd_remark}</Text>}
                </>
              )}
              {item.type === 'overtime' && (
                <Text style={styles.recordMeta}>{item.overtime_date} - {item.hours} hours</Text>
              )}
              {item.note && <Text style={styles.recordMeta}>Note: {item.note}</Text>}
            </View>
          ))
        ) : (
          <Text style={styles.emptyText}>No requests found</Text>
        )
      )}
    </ScrollView>
  );
}

function ApprovalsScreen({ user }: { user: EngineerUser }) {
  const [pendingRequests, setPendingRequests] = useState<RequestItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [remark, setRemark] = useState('');
  const [selectedRequest, setSelectedRequest] = useState<RequestItem | null>(null);

  const loadPending = useCallback(async () => {
    setIsLoading(true);
    try {
      const [leaveRes, overtimeRes] = await Promise.all([
        fetch(`/leave?requesterId=${user.id}&role=${user.role}`).then(r => r.json()),
        fetch(`/overtime?requesterId=${user.id}&role=${user.role}`).then(r => r.json()),
      ]);

      const items: RequestItem[] = [
        ...(leaveRes || []).filter((r: any) =>
          user.role === 'manager_line' ? r.status === 'pending_manager' :
          user.role === 'hrd' ? r.status === 'pending_hrd' : false
        ).map((r: any) => ({ ...r, type: 'leave' as const })),
        ...(overtimeRes || []).filter((r: any) =>
          user.role === 'manager_line' ? r.status === 'pending_manager' :
          user.role === 'hrd' ? r.status === 'pending_hrd' : false
        ).map((r: any) => ({ ...r, type: 'overtime' as const })),
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
    const timer = setInterval(() => { void loadPending(); }, 15 * 60 * 1000);
    return () => clearInterval(timer);
  }, [loadPending]);

  const handleApproval = async (item: RequestItem, action: 'approve' | 'reject') => {
    try {
      const endpoint = item.type === 'leave' ?
        (user.role === 'manager_line' ? '/leave/approve-manager' : '/leave/approve-hrd') :
        (user.role === 'manager_line' ? '/overtime/approve-manager' : '/overtime/approve-hrd');

      const url = `${endpoint}/${item.id}`;
      const body = action === 'approve' ?
        { approverId: user.id } :
        { approverId: user.id, remark: remark || 'Rejected' };

      const result = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (result.ok) {
        Alert.alert('Success', `Request ${action}d successfully`);
        setSelectedRequest(null);
        setRemark('');
        await loadPending();
      } else {
        const error = await result.json();
        Alert.alert('Error', error.error || `Failed to ${action} request`);
      }
    } catch (error) {
      Alert.alert('Error', `Failed to ${action} request`);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.screenContainer}>
      <Text style={styles.title}>Approvals</Text>
      <Text style={styles.subtitle}>
        {user.role === 'manager_line' ? 'Pending Manager Approval' : 'Pending HRD Approval'}
      </Text>

      <Pressable style={[styles.secondaryButton, { marginBottom: 12 }]} onPress={() => { void loadPending(); }}>
        <Text style={styles.secondaryButtonText}>{isLoading ? "Loading..." : "Refresh"}</Text>
      </Pressable>

      {isLoading ? <ActivityIndicator /> : (
        pendingRequests.length > 0 ? (
          pendingRequests.map((item, idx) => (
            <View key={idx} style={styles.recordCard}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={styles.recordTitle}>
                  {item.employee_name || 'Employee'} - {item.type.charAt(0).toUpperCase() + item.type.slice(1)}
                </Text>
                <View style={{
                  backgroundColor: item.type === 'leave' ? '#ffcc00' : '#5856d6',
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 6
                }}>
                  <Text style={{ color: '#fff', fontSize: 10, fontWeight: '600' }}>
                    {item.type === 'leave' ? 'Leave' : 'Overtime'}
                  </Text>
                </View>
              </View>

              {item.type === 'leave' && (
                <Text style={styles.recordMeta}>Period: {item.start_date} s/d {item.end_date}</Text>
              )}
              {item.type === 'overtime' && (
                <Text style={styles.recordMeta}>{item.overtime_date} - {item.hours} hours</Text>
              )}
              {item.note && <Text style={styles.recordMeta}>Note: {item.note}</Text>}

              {selectedRequest?.id === item.id ? (
                <View style={{ marginTop: 12 }}>
                  <TextInput
                    style={[styles.input, { marginBottom: 8 }]}
                    placeholder="Add remark (optional)"
                    value={remark}
                    onChangeText={setRemark}
                    multiline
                  />
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Pressable
                      style={[styles.primaryButton, { flex: 1 }]}
                      onPress={() => handleApproval(item, 'approve')}
                    >
                      <Text style={styles.primaryButtonText}>Approve</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.destructiveButton, { flex: 1 }]}
                      onPress={() => handleApproval(item, 'reject')}
                    >
                      <Text style={styles.destructiveButtonText}>Reject</Text>
                    </Pressable>
                  </View>
                  <Pressable
                    style={{ marginTop: 8 }}
                    onPress={() => { setSelectedRequest(null); setRemark(''); }}
                  >
                    <Text style={{ color: '#007AFF', fontSize: 12, textAlign: 'center' }}>Cancel</Text>
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
        )
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
    if (user.role !== 'hrd' && user.role !== 'admin') return;
    setIsLoading(true);
    try {
      const data = await fetch(`/dashboard?requesterId=${user.id}&role=${user.role}`).then(r => r.json());
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
    const timer = setInterval(() => { void loadStats(); }, 15 * 60 * 1000);
    return () => clearInterval(timer);
  }, [loadStats]);

  if (user.role !== 'hrd' && user.role !== 'admin') {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.screenContainer}>
        <Text style={styles.title}>Dashboard</Text>
        <Text style={styles.subtitle}>Dashboard only available for HRD/Admin</Text>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.screenContainer}>
      <Text style={styles.title}>Dashboard</Text>
      <Text style={[styles.subtitle, {marginBottom: 16}]}>Overview for {user.role.toUpperCase()}</Text>

      {isLoading ? <ActivityIndicator /> : null}

      <View style={styles.statsContainer}>
        <View style={styles.statCard}>
          <Text style={styles.statNumber}>{stats.totalAttendance}</Text>
          <Text style={styles.statLabel}>Total Absensi</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={[styles.statNumber, {color: '#ff9500'}]}>{stats.lateCount}</Text>
          <Text style={styles.statLabel}>Late</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={[styles.statNumber, {color: '#34c759'}]}>{stats.leaveCount}</Text>
          <Text style={styles.statLabel}>Cuti</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={[styles.statNumber, {color: '#5856d6'}]}>{stats.overtimeCount}</Text>
          <Text style={styles.statLabel}>Lembur</Text>
        </View>
      </View>

      <Pressable style={[styles.secondaryButton, {marginTop: 16}]} onPress={() => { void loadStats(); }}>
        <Text style={styles.secondaryButtonText}>{isLoading ? "Loading..." : "Refresh Dashboard"}</Text>
      </Pressable>
    </ScrollView>
  );
}

function PengaturanScreen({ user, onLogout }: { user: EngineerUser; onLogout: () => void }) {
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [serverUrlInput, setServerUrlInput] = useState("");

  const saveServerUrl = async () => {
    if (!serverUrlInput.trim()) {
      Alert.alert("Error", "Server URL cannot be empty");
      return;
    }
    try {
      await saveServerConfig("api_base_url", serverUrlInput.trim());
      setApiBaseUrl(serverUrlInput.trim());
      setSettingsVisible(false);
      Alert.alert("Success", "Server URL saved. Restart the app to apply changes.");
    } catch (error) {
      Alert.alert("Error", "Failed to save server URL");
    }
  };

  const loadCurrentUrl = async () => {
    const url = await getServerConfig("api_base_url");
    setServerUrlInput(url || getApiBaseUrl());
  };

  useEffect(() => {
    if (settingsVisible) {
      loadCurrentUrl();
    }
  }, [settingsVisible]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.screenContainer}>
      <Text style={styles.title}>Settings</Text>
      <Text style={styles.subtitle}>User: {user.name} ({user.role})</Text>

      <Pressable style={[styles.secondaryButton, { marginTop: 20 }]} onPress={() => setSettingsVisible(true)}>
        <Text style={styles.secondaryButtonText}>Server Settings</Text>
      </Pressable>

      <Pressable style={[styles.secondaryButton, { marginTop: 12 }]} onPress={onLogout}>
        <Text style={[styles.secondaryButtonText, { color: "#dc2626" }]}>Logout</Text>
      </Pressable>

      <Modal visible={settingsVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Server Settings</Text>
            <Text style={styles.modalSubtitle}>Enter API Server URL (e.g.: http://192.168.1.21:4000)</Text>
            <TextInput style={styles.input} placeholder="http://IP-ADDRESS:4000" value={serverUrlInput} onChangeText={setServerUrlInput} autoCapitalize="none" keyboardType="url" />
            <Text style={styles.modalHint}>
              • Android Emulator: http://10.0.2.2:4000{"\n"}
              • USB Debugging: http://192.168.1.21:4000{"\n"}
              • Web: http://localhost:4000
            </Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Pressable style={[styles.secondaryButton, { flex: 1 }]} onPress={() => setServerUrlInput('http://10.0.2.2:4000')}>
                <Text style={styles.secondaryButtonText}>Emulator</Text>
              </Pressable>
              <Pressable style={[styles.secondaryButton, { flex: 1 }]} onPress={() => setServerUrlInput('http://192.168.1.21:4000')}>
                <Text style={styles.secondaryButtonText}>USB</Text>
              </Pressable>
              <Pressable style={[styles.secondaryButton, { flex: 1 }]} onPress={() => setServerUrlInput('http://localhost:4000')}>
                <Text style={styles.secondaryButtonText}>Web</Text>
              </Pressable>
            </View>
            <View style={styles.modalButtonRow}>
              <Pressable style={[styles.secondaryButton, styles.flexButton]} onPress={() => setSettingsVisible(false)}>
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </Pressable>
              <Pressable style={[styles.primaryButton, styles.flexButton]} onPress={saveServerUrl}>
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
      setUser(signedUser);
      await cacheSignedInUser(signedUser);
    } catch (error) {
      // If server fails, try local login
      try {
        const localUser = await getLocalUser(email);
        if (localUser) {
          setUser(localUser);
          Alert.alert("Offline Mode", "Logged in from local storage. Data will sync when online.");
        } else {
          const message = error instanceof Error ? error.message : "Login failed. Check email/password or server connection.";
          Alert.alert("Login Failed", message);
        }
      } catch (localError) {
        const localMessage = localError instanceof Error ? localError.message : "Local login failed.";
        const serverMessage = error instanceof Error ? error.message : "Server unreachable.";
        Alert.alert("Login Failed", `${serverMessage}\n\n${localMessage}`);
      }
    }
  };

  const handleLogout = async () => {
    setUser(null);
    setEmailInput("");
    setPasswordInput("");
    // Clear cached user from SQLite (native) or localStorage (web)
    await cacheSignedInUser(null as any);
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
        if (localUrl) {
          setApiBaseUrl(localUrl);
        } else {
          // Set default based on platform
          const defaultUrl = Platform.OS === 'android'
            ? 'http://192.168.1.21:4000'
            : 'http://localhost:4000';
          setApiBaseUrl(defaultUrl);
        }
      } catch (err) {
        console.error("Boot error:", err);
        const fallbackUrl = Platform.OS === 'android'
          ? 'http://192.168.1.21:4000'
          : 'http://localhost:4000';
        setApiBaseUrl(fallbackUrl);
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
          <Text style={styles.subtitle}>Login from Postgres, user saved locally.</Text>
          <TextInput style={styles.input} placeholder="Email" value={emailInput} onChangeText={setEmailInput} autoCapitalize="none" keyboardType="email-address" />
          <TextInput style={styles.input} placeholder="Password" value={passwordInput} onChangeText={setPasswordInput} secureTextEntry />
          <Pressable style={styles.primaryButton} onPress={handleLogin}>
            <Text style={styles.primaryButtonText}>Sign In</Text>
          </Pressable>
          <Text style={styles.subtitle}>Demo: user@apsensi.local / Password09</Text>
        </View>
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
          screenOptions={{
            tabBarActiveTintColor: "#007AFF",
            tabBarInactiveTintColor: "#8E8E93",
            headerShown: false,
            tabBarStyle: {
              backgroundColor: 'rgba(255, 255, 255, 0.95)',
              borderTopWidth: 0.5,
              borderTopColor: 'rgba(0,0,0,0.1)',
              height: 60,
              paddingBottom: 4,
              paddingTop: 4,
              elevation: 8,
              shadowColor: '#000',
              shadowOffset: { width:0, height: -2 },
              shadowOpacity: 0.1,
              shadowRadius: 8,
            },
            tabBarItemStyle: {
              borderRadius: 8,
              marginHorizontal: 4,
            },
            tabBarLabelStyle: {
              fontSize: 10,
              fontWeight: '600',
              marginBottom: 2,
            },
          }}
        >
          <Tab.Screen name="Attendance" options={{ tabBarLabel: 'Attendance' }}>{() => <AbsensiScreen user={user} onLogout={handleLogout} />}</Tab.Screen>
          <Tab.Screen name="Requests" options={{ tabBarLabel: 'Requests' }}>{() => <RequestsScreen user={user} />}</Tab.Screen>
          <Tab.Screen name="News" options={{ tabBarLabel: 'News' }}>{() => <BeritaScreen />}</Tab.Screen>
          {(user.role === 'hrd' || user.role === 'admin' || user.role === 'manager_line') && (
            <Tab.Screen name="Approvals" options={{ tabBarLabel: 'Approvals' }}>{() => <ApprovalsScreen user={user} />}</Tab.Screen>
          )}
          <Tab.Screen name="Settings" options={{ tabBarLabel: 'Settings' }}>{() => <PengaturanScreen user={user} onLogout={handleLogout} />}</Tab.Screen>
        </Tab.Navigator>
      </NavigationContainer>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#f2f2f7",
    paddingTop: Platform.OS === 'android' ? 25 : 0,
  },
  container: {
    flex: 1,
  },
  screenContainer: {
    paddingTop: Platform.OS === 'ios' ? 60 : 50,
    paddingHorizontal: 16,
    paddingBottom: 100,
  },
  topNav: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(242,242,247,0.95)',
    zIndex: 100,
    paddingTop: Platform.OS === 'ios' ? 8 : 0,
    borderBottomWidth: 0.5,
    borderBottomColor: 'rgba(0,0,0,0.1)',
  },
  topNavLine: {
    width: 36,
    height: 4,
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: 2,
  },
  loginContainer: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    paddingTop: Platform.OS === 'android' ? 40 : 20,
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
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    borderWidth: 0,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  primaryButton: {
    backgroundColor: "#007AFF",
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    paddingHorizontal: 14,
    shadowColor: "#007AFF",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 4,
  },
  primaryButtonText: {
    color: "#ffffff",
    fontWeight: "600",
    fontSize: 16,
  },
  secondaryButton: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderWidth: 0,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  secondaryButtonText: {
    color: "#007AFF",
    fontWeight: "600",
    fontSize: 16,
  },
  destructiveButton: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderWidth: 0,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
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
    backgroundColor: "#ffffff",
    borderRadius: 12,
    padding: 14,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 2,
  },
  siteButtonActive: {
    backgroundColor: "#e3f2fd",
    shadowColor: "#007AFF",
    shadowOpacity: 0.3,
    borderWidth: 0,
  },
  siteName: {
    color: "#000000",
    fontWeight: "600",
    fontSize: 15,
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
    backgroundColor: "#ffffff",
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 2,
  },
  recordTitle: {
    fontWeight: "600",
    color: "#000000",
    fontSize: 15,
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
    backgroundColor: "#ffffff",
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 2,
  },
  newsTitle: {
    fontWeight: "600",
    fontSize: 16,
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
    borderRadius: 16,
    padding: 20,
    width: "100%",
    maxWidth: 400,
    paddingBottom: 34,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "600",
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
    backgroundColor: "#ffffff",
    borderRadius: 12,
    padding: 14,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 2,
  },
  statNumber: {
    fontSize: 28,
    fontWeight: "700",
    color: "#007AFF",
  },
  statLabel: {
    fontSize: 12,
    color: "#8e8e93",
    marginTop: 4,
  },
  calendarContainer: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    padding: 14,
    marginTop: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 2,
  },
  calendarHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  calendarTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#000000",
  },
  calendarDay: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: "center",
    alignItems: "center",
    margin: 2,
  },
  calendarDayText: {
    fontSize: 14,
    color: "#000000",
  },
  calendarDayActive: {
    backgroundColor: "#007AFF",
  },
  calendarDayActiveText: {
    color: "#ffffff",
  },
  calendarDayToday: {
    borderWidth: 2,
    borderColor: "#007AFF",
  },
});
