This test is a bit specialized. It is testing how builds are performed against
bundlers. Many JS CDNs use bundlers and might allow importing dd-trace into a
browser where it isn't supposed to be used. These tests ensure no errors occur
when doing so and check that the bundlers still work when targeting node if they
support node.
