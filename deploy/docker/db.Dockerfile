FROM postgis/postgis:16-3.7
COPY server/src/config/init.sql /docker-entrypoint-initdb.d/20-geocsv.sql
