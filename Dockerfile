# Base image
FROM node:18-slim

# Install required system packages
RUN apt-get update && apt-get install -y \
    ffmpeg \
    wget \
    python3 \
    python3-pip \
    build-essential \
    pkg-config \
    libsox-dev \
    libsndfile1-dev \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm ci

# Install Coqui STT
RUN pip3 install --no-cache-dir coqui-stt

# Create directory for models and temp files
RUN mkdir -p models/ukrainian temp

# Copy application code
COPY . .

# Create .env file from example if it doesn't exist
RUN if [ ! -f .env ]; then cp .env.example .env || echo "No .env.example found"; fi

# Download Ukrainian model (uncomment and customize URL if needed)
# RUN wget -O models/ukrainian.tar.gz https://example.com/ukrainian-model.tar.gz \
#     && tar -xzf models/ukrainian.tar.gz -C models/ukrainian \
#     && rm models/ukrainian.tar.gz

# Expose the port the app runs on
EXPOSE 3000

# Start the application
CMD ["npm", "start"]