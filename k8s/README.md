### Building init image

```
cd auto-inst
docker build . --tag bengl/test-auto-inst:latest
docker push bengl/test-auto-inst:latest
```
### Building app image

```
cd sample-app
docker build . --tag bengl/test-sample-app:latest
docker push bengl/test-sample-app:latest
```

### Running with kubernetes

```
kubectl pod delete sample-app # if it's already running
kubectl apply -f pod.yml
# do the following 3 commands in separate terminal windows
kubectl logs -f sample-app
kubectl port-forward sample-app 8080:8080
curl localhost:8080
```
