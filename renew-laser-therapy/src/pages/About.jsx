function About() {
  const testimonials = [
    {
      name: 'Sarah Mitchell',
      role: 'Marketing Executive',
      image: 'SM',
      rating: 5,
      text: 'I started coming to Renew Laser Therapy for skin rejuvenation, and the results have been incredible! My skin looks more radiant, and I feel more confident. The staff is knowledgeable and the environment is so relaxing.',
      results: 'Visible improvement in 3 weeks'
    },
    {
      name: 'Michael Chen',
      role: 'Professional Athlete',
      image: 'MC',
      rating: 5,
      text: 'As an athlete, recovery is everything. Red light therapy at Renew has become an essential part of my routine. I recover faster, feel less sore, and my performance has improved significantly.',
      results: 'Faster recovery time'
    },
    {
      name: 'Jennifer Rodriguez',
      role: 'Entrepreneur',
      image: 'JR',
      rating: 5,
      text: "I was skeptical at first, but after my first month, I'm a believer. My energy levels are up, I sleep better, and I just feel healthier overall. The monthly unlimited package is worth every penny!",
      results: 'Increased energy & better sleep'
    },
    {
      name: 'David Park',
      role: 'Software Engineer',
      image: 'DP',
      rating: 5,
      text: 'Working long hours at a desk was taking a toll on my body. Red light therapy has helped with inflammation and joint pain. Plus, the mental clarity boost is a huge bonus for my work.',
      results: 'Reduced inflammation & pain'
    },
    {
      name: 'Amanda Stevens',
      role: 'Yoga Instructor',
      image: 'AS',
      rating: 5,
      text: 'I recommend Renew Laser Therapy to all my students. The combination of yoga and red light therapy has been transformative for my overall wellness. The team here truly cares about your health journey.',
      results: 'Enhanced overall wellness'
    },
    {
      name: 'Robert Johnson',
      role: 'Retired Teacher',
      image: 'RJ',
      rating: 5,
      text: 'At 68, I was looking for a natural way to maintain my health and vitality. Red light therapy has exceeded my expectations. I have more energy to play with my grandchildren and my mood has improved tremendously.',
      results: 'More energy & improved mood'
    }
  ]

  const stats = [
    { number: '500+', label: 'Happy Clients' },
    { number: '10,000+', label: 'Sessions Completed' },
    { number: '4.9/5', label: 'Average Rating' },
    { number: '2+', label: 'Years in Chicago' }
  ]

  const team = [
    {
      name: 'Dr. Emily Carter',
      role: 'Founder & Wellness Director',
      bio: 'Board-certified physician with 15+ years of experience in integrative medicine and red light therapy.',
      initials: 'EC'
    },
    {
      name: 'Marcus Thompson',
      role: 'Head Therapist',
      bio: 'Certified wellness coach specializing in red light therapy and holistic health approaches.',
      initials: 'MT'
    },
    {
      name: 'Lisa Wong',
      role: 'Client Success Manager',
      bio: 'Dedicated to ensuring every client achieves their wellness goals through personalized care.',
      initials: 'LW'
    }
  ]

  return (
    <div className="pt-20">
      {/* Header */}
      <section className="bg-gradient-to-br from-gray-50 to-white py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h1 className="text-5xl font-bold text-gray-900 mb-4">
            About Renew Laser Therapy
          </h1>
          <p className="text-xl text-gray-600 max-w-2xl mx-auto">
            Chicago's trusted destination for transformative red light therapy
          </p>
        </div>
      </section>

      {/* Our Story */}
      <section className="py-20 bg-white">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-4xl font-bold text-gray-900 mb-6">Our Story</h2>
            <div className="space-y-4 text-lg text-gray-600 text-left">
              <p>
                Founded in 2022, Renew Laser Therapy was born from a simple belief: everyone deserves access to cutting-edge wellness treatments that actually work. Our founder, Dr. Emily Carter, discovered the transformative power of red light therapy while treating patients in her integrative medicine practice.
              </p>
              <p>
                Frustrated by the lack of accessible, high-quality red light therapy options in Chicago, she decided to create a wellness sanctuary where science meets serenity. Today, Renew Laser Therapy stands as Chicago's premier destination for red light therapy, helping hundreds of clients achieve their wellness goals.
              </p>
              <p>
                We combine state-of-the-art technology with personalized care, creating an experience that's as effective as it is relaxing. Our mission is simple: to help you renew your body, revitalize your mind, and rediscover your best self.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Stats */}
      <section className="py-16 bg-red-600">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            {stats.map((stat, index) => (
              <div key={index} className="text-center">
                <div className="text-4xl md:text-5xl font-bold text-white mb-2">
                  {stat.number}
                </div>
                <div className="text-red-100 font-medium">
                  {stat.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Our Team */}
      <section className="py-20 bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-4xl font-bold text-gray-900 mb-4">Meet Our Team</h2>
            <p className="text-xl text-gray-600">
              Passionate experts dedicated to your wellness journey
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {team.map((member, index) => (
              <div key={index} className="bg-white rounded-2xl p-8 text-center shadow-sm">
                <div className="w-24 h-24 bg-gradient-to-br from-red-500 to-red-600 rounded-full mx-auto mb-4 flex items-center justify-center text-white text-2xl font-bold">
                  {member.initials}
                </div>
                <h3 className="text-xl font-bold text-gray-900 mb-1">
                  {member.name}
                </h3>
                <p className="text-red-600 font-medium mb-3">
                  {member.role}
                </p>
                <p className="text-gray-600">
                  {member.bio}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Testimonials */}
      <section className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-4xl font-bold text-gray-900 mb-4">
              What Our Clients Say
            </h2>
            <p className="text-xl text-gray-600">
              Real results from real people
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {testimonials.map((testimonial, index) => (
              <div key={index} className="bg-gray-50 rounded-2xl p-8">
                {/* Rating */}
                <div className="flex mb-4">
                  {[...Array(testimonial.rating)].map((_, i) => (
                    <svg key={i} className="w-5 h-5 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                    </svg>
                  ))}
                </div>

                {/* Testimonial Text */}
                <p className="text-gray-700 mb-6 leading-relaxed">
                  "{testimonial.text}"
                </p>

                {/* Results Badge */}
                <div className="inline-block bg-green-50 text-green-700 px-3 py-1 rounded-full text-sm font-medium mb-4">
                  {testimonial.results}
                </div>

                {/* Author */}
                <div className="flex items-center">
                  <div className="w-12 h-12 bg-red-600 rounded-full flex items-center justify-center text-white font-bold mr-3">
                    {testimonial.image}
                  </div>
                  <div>
                    <p className="font-semibold text-gray-900">{testimonial.name}</p>
                    <p className="text-sm text-gray-600">{testimonial.role}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Science Behind Red Light */}
      <section className="py-20 bg-gray-50">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-4xl font-bold text-gray-900 mb-4">
              The Science Behind Red Light Therapy
            </h2>
            <p className="text-xl text-gray-600">
              Backed by research and proven results
            </p>
          </div>

          <div className="bg-white rounded-2xl p-8 shadow-sm">
            <div className="space-y-6 text-gray-600">
              <p>
                Red light therapy, also known as photobiomodulation, uses specific wavelengths of light (typically 630-850nm) to penetrate the skin and stimulate cellular function. This natural, non-invasive treatment has been extensively studied and shown to provide numerous health benefits.
              </p>

              <div className="bg-red-50 p-6 rounded-xl">
                <h3 className="font-semibold text-gray-900 mb-3">How It Works:</h3>
                <ul className="space-y-2 text-gray-700">
                  <li className="flex items-start">
                    <span className="text-red-600 mr-2">•</span>
                    <span>Light penetrates deep into skin tissue and cells</span>
                  </li>
                  <li className="flex items-start">
                    <span className="text-red-600 mr-2">•</span>
                    <span>Mitochondria absorb the light energy</span>
                  </li>
                  <li className="flex items-start">
                    <span className="text-red-600 mr-2">•</span>
                    <span>ATP (cellular energy) production increases</span>
                  </li>
                  <li className="flex items-start">
                    <span className="text-red-600 mr-2">•</span>
                    <span>Enhanced healing, reduced inflammation, improved cellular function</span>
                  </li>
                </ul>
              </div>

              <p>
                Our state-of-the-art equipment delivers optimal wavelengths at therapeutic intensities, ensuring you receive the full benefits of this revolutionary therapy. With consistent use, clients report improvements in skin health, energy levels, recovery time, mood, and overall wellness.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 bg-gradient-to-br from-red-600 to-red-700 text-white">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-4xl font-bold mb-4">
            Join Our Wellness Community
          </h2>
          <p className="text-xl mb-8 text-red-100">
            Experience the Renew difference for yourself
          </p>
          <a
            href="#book"
            className="inline-block bg-white text-red-600 px-8 py-4 rounded-full text-lg font-medium hover:bg-gray-100 transition-all transform hover:scale-105 shadow-lg"
          >
            Book Your First Session
          </a>
        </div>
      </section>
    </div>
  )
}

export default About
