#!/bin/bash

# App Runner Script for Android USB Debugging & Web
# This script starts the API server and Expo for Android/Web development

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Hybrid Attendance App Launcher${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check prerequisites
echo -e "${YELLOW}Checking prerequisites...${NC}"

if ! command_exists node; then
    echo -e "${RED}Error: Node.js is not installed${NC}"
    exit 1
fi

if ! command_exists npm; then
    echo -e "${RED}Error: npm is not installed${NC}"
    exit 1
fi

if ! command_exists adb; then
    echo -e "${YELLOW}Warning: adb is not installed. Android USB debugging will not work.${NC}"
fi

echo -e "${GREEN}✓ Prerequisites checked${NC}"
echo ""

# Function to kill process on port
kill_port() {
    local port=$1
    if lsof -ti:$port >/dev/null 2>&1; then
        echo -e "${YELLOW}Killing existing process on port $port...${NC}"
        lsof -ti:$port | xargs kill -9 2>/dev/null || true
        sleep 1
    fi
}

# Kill existing processes
kill_port 4000

# Start API Server
echo -e "${BLUE}Starting API Server...${NC}"
cd server
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}Creating .env file...${NC}"
    cat > .env << EOF
PGHOST=localhost
PGPORT=5432
PGDATABASE=apsensi_db
PGUSER=postgres
PGPASSWORD=Password09
API_PORT=4000
EOF
fi

# Install server dependencies if needed
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}Installing server dependencies...${NC}"
    npm install
fi

# Start server in background
echo -e "${GREEN}Starting server on port 4000...${NC}"
PORT=4000 node server.js > ../server.log 2>&1 &
SERVER_PID=$!
echo "Server PID: $SERVER_PID"
cd ..

# Wait for server to start
echo -e "${YELLOW}Waiting for server to start...${NC}"
sleep 3

# Check if server is running
if ! curl -s http://localhost:4000/health >/dev/null 2>&1; then
    echo -e "${RED}Error: Server failed to start. Check server.log for details.${NC}"
    exit 1
fi
echo -e "${GREEN}✓ API Server is running${NC}"
echo ""

# Setup ADB reverse for Android USB debugging
if command_exists adb; then
    echo -e "${BLUE}Setting up ADB reverse for Android...${NC}"
    if adb devices | grep -q "device$"; then
        adb reverse tcp:4000 tcp:4000
        echo -e "${GREEN}✓ ADB reverse set up successfully${NC}"
        echo -e "${GREEN}  Android can now access API at http://localhost:4000${NC}"
    else
        echo -e "${YELLOW}Warning: No Android device connected via USB${NC}"
        echo -e "${YELLOW}  Connect your Android device and enable USB debugging${NC}"
    fi
else
    echo -e "${YELLOW}Skipping ADB setup (adb not found)${NC}"
fi
echo ""

# Install Expo dependencies if needed
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}Installing app dependencies...${NC}"
    npm install
fi

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Ready to launch!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${BLUE}Choose platform to run:${NC}"
echo "  1) Android (USB debugging)"
echo "  2) Web (browser)"
echo "  3) Both (Android + Web)"
echo "  4) iOS (if on macOS)"
echo "  q) Quit"
echo ""
read -p "Enter your choice [1-4 or q]: " choice

case $choice in
    1)
        echo -e "${GREEN}Starting on Android...${NC}"
        npx expo start --android
        ;;
    2)
        echo -e "${GREEN}Starting on Web...${NC}"
        npx expo start --web
        ;;
    3)
        echo -e "${GREEN}Starting on Android and Web...${NC}"
        npx expo start --android --web
        ;;
    4)
        if [[ "$OSTYPE" == "darwin"* ]]; then
            echo -e "${GREEN}Starting on iOS...${NC}"
            npx expo start --ios
        else
            echo -e "${RED}iOS is only available on macOS${NC}"
            npx expo start
        fi
        ;;
    q|Q)
        echo -e "${YELLOW}Stopping server...${NC}"
        kill $SERVER_PID 2>/dev/null || true
        echo -e "${GREEN}Done!${NC}"
        exit 0
        ;;
    *)
        echo -e "${GREEN}Starting Expo (select platform from QR code)...${NC}"
        npx expo start
        ;;
esac

# Cleanup on exit
trap "echo -e '${YELLOW}Stopping server...${NC}'; kill $SERVER_PID 2>/dev/null || true; exit 0" INT TERM EXIT
