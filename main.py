from fastapi import FastAPI
import psycopg2

app = FastAPI()

@app.get("/")
def read_root():
    return {"message": "Attendance API running"}

@app.post("/checkin")
def checkin(employee_id: int, latitude: float, longitude: float):
    conn = psycopg2.connect(
        dbname="apsensi_db",
        user="postgres",
        password="Password09",
        host="localhost",
        port="5432"
    )
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO attendance (employee_id, check_in, latitude, longitude, synced) VALUES (%s, NOW(), %s, %s, FALSE)",
        (employee_id, latitude, longitude)
    )
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}
