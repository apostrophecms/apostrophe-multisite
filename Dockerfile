FROM node:12

# Create app directory
RUN mkdir -p /app
WORKDIR /app

# Install node modules
COPY package*.json /app/
RUN cd /app && npm install --registry=https://registry.npmjs.org/

# Install application
COPY . /app

CMD ["npm", "run", "test"]
