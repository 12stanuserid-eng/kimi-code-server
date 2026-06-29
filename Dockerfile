FROM ttl.sh/pentaract-temp:latest
# Test: override entrypoint to check if the image itself is OK
ENTRYPOINT ["sleep", "9999"]
