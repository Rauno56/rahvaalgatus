Rahvaalgatus
============
The frontend for <https://rahvaalgatus.ee>, dependent on [CitizenOS]'s backend.

[CitizenOS]: https://citizenos.com


Development
-----------
An Angular-based frontend built upon the proof-of-concept of CitizenOS's frontend.

1. Install the JavaScript modules necessary for building the frontend:

   ```sh
   npm install
   ```

2. Compile the frontend with Make:

   ```sh
   make compile
   ```

3. Run the server in another tab:
   ```sh
   make server
   ```

   For a different port, pass `PORT` to Make:
   ```sh
   make server PORT=8888
   ```

4. Set up a <*.rahvaalgatus.ee> domain.

   CitizenOS's backend server replies to cross-origin requests only if they come from `*.rahvalgatus.ee`. Add such a subdomain to your `/etc/hosts` file for development:

   ```
   127.0.0.1 dev.rahvaalgatus.ee
   ```

5. Open your local domain (e.g. <http://dev.rahvaalgatus.ee:3000>) in your browser and proceed with code typing.

### Autocompiling

To have the frontend be compiled automatically as you change files, use `autocompile`:

```sh
make autocompile
```

### Environments

Environment specific configuration is in `config/$ENV.js`. It'll get included in the app during complication.

For example, to compile for the production environment, set `ENV` to `production`:

```sh
make compile ENV=production
```

### Signin

To sign in during development, use one of the [Mobile-Id test phone numbers](http://www.id.ee/?lang=en&id=36381):

Phone        | Personal id
-------------|------------
+37200000766 | 11412090004
+37060000007 | 51001091072

See more at <http://www.id.ee/?lang=en&id=36381>.


Testing
-------
The project has JavaScript server unit tests and Selenium WebDriver based UI tests ready:

1. Run unit tests with `test`:

   ```sh
   make test
   ```

2. Run UI tests with `test` and `TEST=ui`:

   ```sh
   make test TEST=ui
   ```


### Autotesting

To have the UI tests run automatically as you change files, use `autotest`:

```sh
make autotest
```
