FROM ttl.sh/pentaract-temp:latest
COPY entry.sh /entry.sh
RUN chmod +x /entry.sh
EXPOSE 10000
ENTRYPOINT ["/entry.sh"]
