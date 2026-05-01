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
} from "./src/services/localDb";

const Tab = createBottomTabNavigator();

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
  return new Date(iso).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
};

function AbsensiScreen({ user, onLogout }: { user: EngineerUser; onLogout: () => void }) {
  const [selectedSiteId, setSelectedSiteId] = useState(PROJECT_SITES[0].id);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastMessage, setLastMessage] = useState("No attendance activity yet.");
  const [isSyncing, setIsSyncing] = useState(false);
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [isLoadingRecords, setIsLoadingRecords] = useState(false);

  const selectedSite: Site = useMemo(() => {
    const found = PROJECT_SITES.find((site) => site.id === selectedSiteId);
    return found ?? PROJECT_SITES[0];
  }, [selectedSiteId]);

  const loadAttendance = useCallback(async () => {
    setIsLoadingRecords(true);
    try {
      const remote = await fetchAttendanceRecords(user.id, user.role);
      setRecords(remote);
    } catch {
      const local = await getLocalAttendanceForUser(user.id);
      setRecords(local);
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
    if (user.role !== "user" && user.role !== "hrd") {
      Alert.alert("Access Denied", "Only users with 'user' or 'hrd' role can check-in/check-out.");
      return;
    }
    setIsSubmitting(true);
    try {
      const permission = await Location.getForegroundPermissionsAsync();
      if (!permission.granted) {
        const requested = await Location.requestForegroundPermissionsAsync();
        if (!requested.granted) {
          Alert.alert(
            "Location Permission Required",
            "Please enable location access in Settings to perform attendance. Go to Settings > Apps > [App Name] > Permissions > Location.",
            [{ text: "OK" }]
          );
          return;
        }
      }

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("GPS timeout. Please try again in an open area.")), 30000)
      );
      const locationPromise = Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
        timeInterval: 10000,
      });

      const position = await Promise.race([locationPromise, timeoutPromise]) as Location.LocationObject;
      const { latitude, longitude, accuracy } = position.coords;

      if (accuracy && accuracy > 100) {
        Alert.alert(
          "Low GPS Accuracy",
          `GPS accuracy is ${Math.round(accuracy)}m (minimum 100m required). Please move to an open area and try again.`,
          [{ text: "Retry" }, { text: "Continue", onPress: () => submitAttendance(mode) }]
        );
        return;
      }

      if (!latitude || !longitude) {
        Alert.alert("GPS Error", "Unable to get valid GPS coordinates. Please try again.");
        return;
      }

      const distance = haversineDistanceMeters(latitude, longitude, selectedSite.latitude, selectedSite.longitude);
      const withinGeofence = distance <= selectedSite.radiusMeters;
      const locationType = withinGeofence ? "onsite" : "offsite";

      if (mode === "check-in") {
        await saveCheckInLocal(user.id, latitude, longitude, locationType);
      } else {
        const updated = await saveCheckOutLocal(user.id, latitude, longitude, locationType);
        if (!updated) {
          Alert.alert("Check-out Failed", "No open check-in record found.");
          return;
        }
      }
      setLastMessage(`${mode === "check-in" ? "Check-in" : "Check-out"} saved locally (${locationType === "onsite" ? "inside area" : "outside area"}, distance ${Math.round(distance)}m, accuracy ${Math.round(accuracy || 0)}m).`);
      await runSync();
    } catch (error) {
      const message = error instanceof Error ? error.message : "An unknown error occurred.";
      Alert.alert("Attendance Failed", message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const isSameDay = (d1: Date, d2: Date) => {
    return d1.getFullYear() === d2.getFullYear() &&
      d1.getMonth() === d2.getMonth() &&
      d1.getDate() === d2.getDate();
  };

  const isLate = (checkInStr: string) => {
    try {
      const d = new Date(checkInStr);
      const jakartaTime = new Date(d.getTime() + (7 * 60 * 60 * 1000));
      const hours = jakartaTime.getUTCHours();
      const minutes = jakartaTime.getUTCMinutes();
      return (hours > 9) || (hours === 9 && minutes > 0);
    } catch {
      return false;
    }
  };

  const getDayStatus = (day: number) => {
    const dateStr = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dayRecords = records.filter(r => r.check_in && r.check_in.startsWith(dateStr));
    const today = new Date();
    const dayDate = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), day);

    // Check if holiday
    if (isHoliday(dayDate)) {
      return 'holiday';
    }

    if (dayRecords.length === 0) {
      if (dayDate < today && !isSameDay(dayDate, today)) {
        return 'no-checkin';
      }
      if (dayDate > today) return 'future';
      return 'none';
    }

    const hasLate = dayRecords.some(r => r.check_in && isLate(r.check_in));
    if (hasLate) return 'late';

    const hasForgetCheckout = dayRecords.some(r => !r.check_out);
    if (hasForgetCheckout) return 'forget-checkout';

    return 'checked-in';
  };

  const getDaysInMonth = (date: Date) => {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  };

  const getFirstDayOfMonth = (date: Date) => {
    return new Date(date.getFullYear(), date.getMonth(), 1).getDay();
  };

  const renderCalendar = () => {
    const daysInMonth = getDaysInMonth(selectedDate);
    const firstDay = getFirstDayOfMonth(selectedDate);
    const days = [];
    const today = new Date();

    for (let i = 0; i < firstDay; i++) {
      days.push(<View key={`empty-${i}`} style={styles.calendarDay} />);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const status = getDayStatus(day);
      const isToday = isSameDay(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), day), today);
      const isSelected = selectedDate.getDate() === day;

      let dayStyle = [styles.calendarDay];
      let textStyle = [styles.calendarDayText];

      if (status === 'checked-in') {
        dayStyle.push({ backgroundColor: '#007AFF' });
        textStyle.push({ color: '#fff' });
      } else if (status === 'late') {
        dayStyle.push({ backgroundColor: '#ffcc00' });
        textStyle.push({ color: '#000' });
      } else if (status === 'no-checkin') {
        dayStyle.push({ backgroundColor: '#ff3b30' });
        textStyle.push({ color: '#fff' });
      } else if (status === 'forget-checkout') {
        dayStyle.push({ backgroundColor: '#8e8e93' });
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
    const dateStr = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}-${String(selectedDate.getDate()).padStart(2, '0')}`;
    return records.filter(r => r.check_in && r.check_in.startsWith(dateStr));
  })();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.screenContainer}>
      <Text style={styles.title}>Hello, {user.role === 'user' ? 'Field Engineer' : user.name}</Text>
      <Text style={styles.subtitle}>Role: {user.role}</Text>

      {user.role === "user" ? (
        <>
          <Text style={styles.sectionLabel}>Select project site</Text>
          <View style={styles.siteList}>
            {PROJECT_SITES.map((site) => {
              const active = site.id === selectedSiteId;
              return (
                <Pressable
                  key={site.id}
                  style={[styles.siteButton, active && styles.siteButtonActive]}
                  onPress={() => setSelectedSiteId(site.id)}
                >
                  <Text style={[styles.siteName, active && styles.siteNameActive]}>{site.name}</Text>
                  <Text style={[styles.siteMeta, active && styles.siteNameActive]}>Radius {site.radiusMeters}m</Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.actionRow}>
            <Pressable style={[styles.primaryButton, styles.flexButton]} disabled={isSubmitting} onPress={() => submitAttendance("check-in")}>
              <Text style={styles.primaryButtonText}>Check-in</Text>
            </Pressable>
            <Pressable style={[styles.secondaryButton, styles.flexButton]} disabled={isSubmitting} onPress={() => submitAttendance("check-out")}>
              <Text style={styles.secondaryButtonText}>Check-out</Text>
            </Pressable>
          </View>
        </>
      ) : null}

      <View style={styles.actionRow}>
        <Pressable style={[styles.secondaryButton, styles.flexButton]} disabled={isSyncing} onPress={() => { void runSync(); }}>
          <Text style={styles.secondaryButtonText}>{isSyncing ? "Syncing..." : "Sync Now"}</Text>
        </Pressable>
      </View>

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
            {selectedDate.toLocaleString('id-ID', { month: 'long', year: 'numeric' })}
          </Text>
          <Pressable onPress={() => setSelectedDate(new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1))}>
            <Text style={{ color: '#007AFF', fontSize: 18 }}>›</Text>
          </Pressable>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' }}>
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
            <Text key={d} style={{ width: 36, textAlign: 'center', fontSize: 10, color: '#8e8e93', margin: 2 }}>{d}</Text>
          ))}
          {renderCalendar()}
        </View>
      </View>

      <View style={{ marginTop: 16 }}>
        <Text style={{ fontSize: 14, fontWeight: '600', color: '#000', marginBottom: 8 }}>
          {selectedDate.toLocaleString('id-ID', { day: 'numeric', month: 'long' })}
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

      <View style={{ marginTop: 12, padding: 10, backgroundColor: '#fff', borderRadius: 12 }}>
        <Text style={{ fontSize: 12, color: '#8e8e93', marginBottom: 6 }}>Legend:</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: '#007AFF' }} />
            <Text style={{ fontSize: 10, color: '#8e8e93' }}>Check-in</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: '#ffcc00' }} />
            <Text style={{ fontSize: 10, color: '#8e8e93' }}>Late</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: '#ff3b30' }} />
            <Text style={{ fontSize: 10, color: '#8e8e93' }}>No Check-in</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: '#8e8e93' }} />
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

  const getDaysInMonth = (date: Date) => {
    const year = date.getFullYear();
    const month = date.getMonth();
    return new Date(year, month + 1, 0).getDate();
  };

  const getFirstDayOfMonth = (date: Date) => {
    return new Date(date.getFullYear(), date.getMonth(), 1).getDay();
  };

  const hasAttendanceOnDay = (day: number) => {
    const dateStr = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return records.some(r => r.check_in && r.check_in.startsWith(dateStr));
  };

  const getRecordsForDay = (day: number) => {
    const dateStr = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return records.filter(r => r.check_in && r.check_in.startsWith(dateStr));
  };

  const renderCalendar = () => {
    const daysInMonth = getDaysInMonth(selectedDate);
    const firstDay = getFirstDayOfMonth(selectedDate);
    const days = [];

    for (let i = 0; i < firstDay; i++) {
      days.push(<View key={`empty-${i}`} style={styles.calendarDay} />);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const hasRecord = hasAttendanceOnDay(day);
      const isToday = new Date().getDate() === day &&
        new Date().getMonth() === selectedDate.getMonth() &&
        new Date().getFullYear() === selectedDate.getFullYear();

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
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
                <Text key={d} style={{width: 36, textAlign: 'center', fontSize: 10, color: '#8e8e93', margin: 2}}>{d}</Text>
              ))}
              {renderCalendar()}
            </View>
          </View>

          <View style={{marginTop: 16}}>
            <Text style={{fontSize: 14, fontWeight: '600', color: '#000', marginBottom: 8}}>
              {selectedDate.toLocaleString('id-ID', { day: 'numeric', month: 'long' })}
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

  const handleLogout = () => {
    setUser(null);
    setEmailInput("");
    setPasswordInput("");
  };

  useEffect(() => {
    const boot = async () => {
      try {
        await initializeLocalDb();
        const localUrl = await getServerConfig("api_base_url");
        if (localUrl) {
          setApiBaseUrl(localUrl);
        } else {
          // Set default based on platform
          const defaultUrl = Platform.OS === 'android' 
            ? 'http://192.168.1.21:4000'  // For physical devices
            : 'http://localhost:4000';     // For iOS/web
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
          <Tab.Screen name="News" options={{ tabBarLabel: 'News' }}>{() => <BeritaScreen />}</Tab.Screen>
          {(user.role === 'hrd' || user.role === 'admin') && (
            <Tab.Screen name="Dashboard" options={{ tabBarLabel: 'Dashboard' }}>{() => <DashboardScreen user={user} />}</Tab.Screen>
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
