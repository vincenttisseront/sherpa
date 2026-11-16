# Hôte SSH de développement : moteur Docker isolé (Docker-in-Docker) joignable
# uniquement en SSH (mot de passe ou clé), sans agent Portainer ni Runner.
FROM docker:29.5.2-dind-alpine3.23
RUN apk add --no-cache openssh-server ca-certificates \
 && (getent group docker || addgroup -S docker) \
 && adduser -D -s /bin/sh -G docker deploy \
 && mkdir -p /home/deploy/.ssh /srv/apps \
 && chown -R deploy:docker /home/deploy/.ssh /srv/apps \
 && chmod 700 /home/deploy/.ssh
COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/ssh-dev-entrypoint.sh
RUN chmod 0755 /usr/local/bin/ssh-dev-entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/ssh-dev-entrypoint.sh"]
