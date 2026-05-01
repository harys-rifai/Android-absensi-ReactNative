// Cleanup script for duplicate attendance records
// Run this in browser console at http://localhost:4000 or http://localhost:19006

(function() {
  console.log('Starting cleanup of duplicate attendance records...');

  // Get attendance data from localStorage
  const attendanceData = localStorage.getItem('attendance');
  if (!attendanceData) {
    console.log('No attendance data found in localStorage');
    return;
  }

  const attendance = JSON.parse(attendanceData);
  console.log(`Found ${attendance.length} total records`);

  // Group by date (YYYY-MM-DD)
  const recordsByDate = {};
  attendance.forEach(record => {
    if (record.check_in) {
      const date = record.check_in.split('T')[0]; // YYYY-MM-DD
      if (!recordsByDate[date]) {
        recordsByDate[date] = [];
      }
      recordsByDate[date].push(record);
    }
  });

  // Keep only one check-in and one check-out per day per employee
  const cleanedAttendance = [];

  Object.keys(recordsByDate).forEach(date => {
    const dayRecords = recordsByDate[date];

    // Group by employee
    const byEmployee = {};
    dayRecords.forEach(record => {
      const empId = record.employee_id;
      if (!byEmployee[empId]) {
        byEmployee[empId] = [];
      }
      byEmployee[empId].push(record);
    });

    // For each employee, keep only earliest check-in and latest check-out
    Object.keys(byEmployee).forEach(empId => {
      const empRecords = byEmployee[empId];

      // Find earliest check-in
      const withCheckIn = empRecords.filter(r => r.check_in);
      if (withCheckIn.length > 0) {
        const earliest = withCheckIn.reduce((prev, curr) =>
          prev.check_in < curr.check_in ? prev : curr
        );
        cleanedAttendance.push(earliest);
      }

      // Find record with check-out (if different from check-in)
      const withCheckOut = empRecords.filter(r => r.check_out);
      if (withCheckOut.length > 0) {
        // Keep the one that has both check-in and check-out, or the latest
        const withBoth = withCheckOut.filter(r => r.check_in);
        if (withBoth.length > 0) {
          // If we already added this record as check-in, update it with check-out
          const existing = cleanedAttendance.find(r =>
            r.employee_id === parseInt(empId) &&
            r.check_in && r.check_in.split('T')[0] === date
          );
          if (existing && !existing.check_out) {
            existing.check_out = withBoth[0].check_out;
            existing.synced = 0;
          }
        } else {
          // Just has check-out, add it
          const latest = withCheckOut.reduce((prev, curr) =>
            prev.check_out > curr.check_out ? prev : curr
          );
          // Don't add if already have this date for this employee
          const exists = cleanedAttendance.some(r =>
            r.employee_id === parseInt(empId) &&
            r.check_in && r.check_in.split('T')[0] === date
          );
          if (!exists) {
            cleanedAttendance.push(latest);
          }
        }
      }
    });
  });

  console.log(`Cleaned: ${attendance.length} -> ${cleanedAttendance.length} records`);

  // Save cleaned data back to localStorage
  localStorage.setItem('attendance', JSON.stringify(cleanedAttendance));

  // Also clean up for May 2, 2026 specifically (remove all but one check-in/check-out)
  const may2Records = cleanedAttendance.filter(r =>
    r.check_in && r.check_in.startsWith('2026-05-02')
  );
  console.log(`May 2 records after cleanup: ${may2Records.length}`);

  if (may2Records.length > 1) {
    console.log('Still have duplicates for May 2, doing specific cleanup...');
    const may2Cleaned = [];
    const seen = new Set();

    cleanedAttendance.forEach(record => {
      if (record.check_in) {
        const date = record.check_in.split('T')[0];
        const key = `${record.employee_id}-${date}`;
        if (!seen.has(key)) {
          seen.add(key);
          may2Cleaned.push(record);
        }
      } else {
        may2Cleaned.push(record);
      }
    });

    localStorage.setItem('attendance', JSON.stringify(may2Cleaned));
    console.log(`Final cleanup: ${may2Cleaned.length} total records`);
  }

  console.log('Cleanup complete! Refresh the page to see changes.');
  console.log('Remaining records:', JSON.parse(localStorage.getItem('attendance')).length);
})();
