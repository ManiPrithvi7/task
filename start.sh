#!/bin/bash
# Quick start script for MQTT Publisher Lite

echo "🚀 Starting MQTT Publisher Lite..."
echo ""

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
    echo ""
fi

# Check if dist exists
if [ ! -d "dist" ]; then
    echo "🔨 Building application..."
    npm run build
    echo ""
fi

# Create data directory
mkdir -p data

echo "✅ Starting application..."
echo ""

# Start the application
npm start
