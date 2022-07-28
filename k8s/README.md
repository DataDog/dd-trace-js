Here are some instructions for working with the init image for local
development (i.e. when working on the init image itself).

Replace any namespaces with your own, including in `local-pod.yml`.

### Building init image

```
cd auto-inst
docker build . --tag bengl/test-auto-inst:latest
docker push bengl/test-auto-inst:latest
```

### Building sample app image

```
cd sample-app
docker build . --tag bengl/test-sample-app:latest
docker push bengl/test-sample-app:latest
```

### Running with kubernetes

```
kubectl pod delete sample-app # if it's already running
kubectl apply -f local-pod.yml
# do the following 3 commands in separate terminal windows
kubectl logs -f sample-app
kubectl port-forward sample-app 18080:18080
curl localhost:18080
```
