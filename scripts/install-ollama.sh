#!/bin/bash

# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Wait for Ollama to be ready
sleep 10

# Pull required models
ollama pull gemma4:12b-mlx
ollama pull mistral-medium-3.5

# Verify installation
ollama list