$version: "2"

namespace com.aws.solutions.deepracer

@http(method: "POST", uri: "/profile/basic")
operation CreateBasicProfile {
    input := {
        @required
        alias: String

        @required
        country: String
    }

    output := {
        @required
        message: String
    }
}
