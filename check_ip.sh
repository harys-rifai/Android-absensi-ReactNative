#!/bin/bash
echo "Local IP Addresses:"
echo "-------------------"
ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}'

echo ""
echo "Public IP Address:"
echo "------------------"
curl -s ifconfig.me
echo ""
