FROM ghcr.io/project-osrm/osrm-backend:v6.0.0

COPY start.sh /opt/start.sh
RUN chmod 0755 /opt/start.sh

EXPOSE 5000 5001
CMD ["/opt/start.sh"]
